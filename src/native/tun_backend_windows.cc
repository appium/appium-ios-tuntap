#ifdef _WIN32

#include "tun_backend.h"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <sstream>
#include <thread>
#include <utility>
#include <vector>

#include "handle.h"
#include "wintun_loader.h"

namespace {

constexpr LPCWSTR kTunnelType = L"AppiumTunTap";
constexpr DWORD kSessionCapacity = 0x400000; // 4 MiB; must be power of two.

// WinTun adapter names are limited to MAX_ADAPTER_NAME-1 wide chars (~127).
// We stay well under that.
std::wstring BuildDefaultAdapterName() {
  std::wostringstream oss;
  oss << L"appium-tun" << ::GetCurrentProcessId() << L"-" << ::GetTickCount();
  return oss.str();
}

class WindowsTunBackend : public TunPlatformBackend {
public:
  WindowsTunBackend() = default;
  ~WindowsTunBackend() override {
    StopReceiveLoop();
    EndSessionInternal();
    CloseAdapterInternal();
  }

  WindowsTunBackend(const WindowsTunBackend&) = delete;
  WindowsTunBackend& operator=(const WindowsTunBackend&) = delete;
  WindowsTunBackend(WindowsTunBackend&&) = delete;
  WindowsTunBackend& operator=(WindowsTunBackend&&) = delete;

  bool OpenDevice(const std::string& requested_name,
                  std::string& out_interface_name,
                  std::string& error) override {
    auto& api = WintunApi::Instance();
    if (!api.Load(error)) {
      return false;
    }

    std::wstring adapter_name =
        requested_name.empty() ? BuildDefaultAdapterName() : Utf8ToUtf16(requested_name);
    if (adapter_name.empty()) {
      error = "Failed to encode adapter name as UTF-16";
      return false;
    }

    // Creating or opening a WinTun adapter requires the process to run with
    // administrator privileges (elevated). Without elevation `CreateAdapter`
    // fails with ERROR_ACCESS_DENIED, which `FormatLastError` surfaces in the
    // error string below. This mirrors the root (EUID 0) requirement of the
    // POSIX backends.
    //
    // Prefer creating a fresh adapter so `WintunCloseAdapter` on shutdown
    // also tears down the kernel object. Falling back to `OpenAdapter`
    // handles the "leftover from a crashed process" case where the adapter
    // already exists; that adapter will likewise be removed on close, which
    // is the desired behavior — we do not want stale adapters to accumulate.
    adapter_ = api.CreateAdapter(adapter_name.c_str(), kTunnelType, nullptr);
    if (!adapter_) {
      DWORD created_err = ::GetLastError();
      adapter_ = api.OpenAdapter(adapter_name.c_str());
      if (!adapter_) {
        DWORD opened_err = ::GetLastError();
        error = "Failed to create or open WinTun adapter: create failed with " +
                FormatLastError(created_err) + "; open failed with " +
                FormatLastError(opened_err);
        return false;
      }
    }

    session_ = api.StartSession(adapter_, kSessionCapacity);
    if (!session_) {
      error = "Failed to start WinTun session: " + FormatLastError(::GetLastError());
      CloseAdapterInternal();
      return false;
    }

    read_event_ = api.GetReadWaitEvent(session_);
    if (!read_event_) {
      error = "Failed to acquire WinTun read-wait event: " + FormatLastError(::GetLastError());
      EndSessionInternal();
      CloseAdapterInternal();
      return false;
    }

    interface_name_ = Utf16ToUtf8(adapter_name);
    if (interface_name_.empty()) {
      error = "Failed to encode adapter name as UTF-8";
      EndSessionInternal();
      CloseAdapterInternal();
      return false;
    }

    out_interface_name = interface_name_;
    return true;
  }

  void CloseDevice() override {
    StopReceiveLoop();
    EndSessionInternal();
    CloseAdapterInternal();
    interface_name_.clear();
  }

  bool IsOpen() const override { return session_ != nullptr; }

  ReadPacketStatus ReadPacket(size_t max_payload_size,
                              std::vector<uint8_t>& out,
                              std::string& error) override {
    if (!session_) {
      error = "Device not open";
      return ReadPacketStatus::Error;
    }

    auto& api = WintunApi::Instance();
    DWORD packet_size = 0;
    BYTE* packet = api.ReceivePacket(session_, &packet_size);
    if (!packet) {
      DWORD err = ::GetLastError();
      switch (err) {
        case ERROR_NO_MORE_ITEMS:
          out.clear();
          return ReadPacketStatus::NoData;
        case ERROR_HANDLE_EOF:
          out.clear();
          return ReadPacketStatus::Closed;
        default:
          out.clear();
          error = "WintunReceivePacket failed: " + FormatLastError(err);
          return ReadPacketStatus::Error;
      }
    }

    const size_t copy_len = static_cast<size_t>(packet_size) > max_payload_size
                                ? max_payload_size
                                : static_cast<size_t>(packet_size);
    out.assign(packet, packet + copy_len);
    api.ReleaseReceivePacket(session_, packet);
    return ReadPacketStatus::Data;
  }

  ssize_t WritePacket(const uint8_t* data,
                      size_t length,
                      std::string& error) override {
    if (!session_) {
      error = "Device not open";
      return -1;
    }
    if (length == 0) {
      return 0;
    }
    if (length > WINTUN_MAX_IP_PACKET_SIZE) {
      error = "Packet exceeds WINTUN_MAX_IP_PACKET_SIZE";
      return -1;
    }

    auto& api = WintunApi::Instance();
    BYTE* slot = api.AllocateSendPacket(session_, static_cast<DWORD>(length));
    if (!slot) {
      DWORD err = ::GetLastError();
      if (err == ERROR_HANDLE_EOF) {
        error = "WinTun adapter is terminating";
      } else if (err == ERROR_BUFFER_OVERFLOW) {
        return 0;
      } else {
        error = "WintunAllocateSendPacket failed: " + FormatLastError(err);
      }
      return -1;
    }

    std::memcpy(slot, data, length);
    api.SendPacket(session_, slot);
    return static_cast<ssize_t>(length);
  }

  // The worker thread can begin invoking `on_packet`/`on_error` immediately
  // after this returns; callers must therefore not assume callbacks fire
  // only after the function returns. In practice the callbacks defined in
  // `tuntap.cc` either marshal to libuv via TSFN (`on_packet`) or take
  // `device_mutex_` (`on_error`). Brief contention on `device_mutex_` is
  // expected and resolves on the order of microseconds because
  // `std::thread`'s constructor does not block on the worker reaching its
  // first instruction. There is no deadlock risk because the calling JS
  // thread releases the lock as soon as `StartPolling` returns.
  bool StartReceiveLoop(uv_loop_t* /*loop*/,
                        size_t buffer_size,
                        PacketCallback on_packet,
                        ErrorCallback on_error,
                        std::string& error) override {
    if (!session_) {
      error = "Device not open";
      return false;
    }
    if (buffer_size == 0) {
      error = "Invalid receive-loop parameters";
      return false;
    }
    if (worker_running_.load()) {
      error = "Receive loop already started";
      return false;
    }

    quit_event_.reset(::CreateEventW(nullptr, /*manualReset=*/TRUE,
                                     /*initialState=*/FALSE, nullptr));
    if (!quit_event_.is_valid()) {
      error = "Failed to create quit event: " + FormatLastError(::GetLastError());
      return false;
    }

    worker_running_.store(true);
    try {
      worker_ = std::thread(&WindowsTunBackend::WorkerMain, this, buffer_size,
                            std::move(on_packet), std::move(on_error));
    } catch (const std::system_error& sysErr) {
      worker_running_.store(false);
      quit_event_.reset();
      error = std::string("Failed to spawn receive thread: ") + sysErr.what();
      return false;
    }
    return true;
  }

  void StopReceiveLoop() override {
    if (!worker_.joinable()) {
      // Either never started or already cleaned up. Reset the event in case
      // it was created without ever spawning a thread.
      quit_event_.reset();
      receive_paused_.store(false);
      return;
    }
    worker_running_.store(false);
    receive_paused_.store(false);
    if (quit_event_.is_valid()) {
      ::SetEvent(quit_event_.get());
    }
    worker_.join();
    quit_event_.reset();
  }

  void PauseReceiveLoop() override { receive_paused_.store(true); }

  void ResumeReceiveLoop() override { receive_paused_.store(false); }

  // WinTun exposes no POSIX file descriptor: its readable object is a Win32
  // event `HANDLE`, not a numeric fd. Always -1 — the N-API layer treats -1
  // as "no pollable fd" and drives delivery through `StartReceiveLoop`.
  int GetNativeFd() const override { return -1; }

  bool WaitReadable(const std::atomic<bool>& running, std::string& error) override {
    if (!read_event_) {
      error = "Device not open";
      return false;
    }

    while (running.load()) {
      DWORD wait = ::WaitForSingleObject(read_event_, 200);
      if (wait == WAIT_OBJECT_0) {
        return true;
      }
      if (wait == WAIT_TIMEOUT) {
        continue;
      }
      error = "WaitForSingleObject failed: " + FormatLastError(::GetLastError());
      return false;
    }

    return false;
  }

  bool WaitWritable(const std::atomic<bool>& running, std::string& /*error*/) override {
    // WinTun exposes only a read-wait event. A short sleep prevents a busy spin
    // when the send ring is temporarily full.
    if (running.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return running.load();
    }
    return false;
  }

private:
  static std::string Utf16ToUtf8(const std::wstring& utf16) {
    if (utf16.empty()) {
      return std::string();
    }
    int len = ::WideCharToMultiByte(CP_UTF8, 0, utf16.c_str(),
                                    static_cast<int>(utf16.size()), nullptr, 0,
                                    nullptr, nullptr);
    if (len <= 0) {
      return std::string();
    }
    std::string out(static_cast<size_t>(len), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, utf16.c_str(),
                          static_cast<int>(utf16.size()), out.data(), len,
                          nullptr, nullptr);
    return out;
  }

  void EndSessionInternal() {
    if (session_) {
      WintunApi::Instance().EndSession(session_);
      session_ = nullptr;
    }
    read_event_ = nullptr;
  }

  void CloseAdapterInternal() {
    if (adapter_) {
      WintunApi::Instance().CloseAdapter(adapter_);
      adapter_ = nullptr;
    }
  }

  void WorkerMain(size_t buffer_size,
                  PacketCallback on_packet,
                  ErrorCallback on_error) {
    auto& api = WintunApi::Instance();
    HANDLE wait_handles[2] = {read_event_, quit_event_.get()};

    while (worker_running_.load()) {
      while (receive_paused_.load() && worker_running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      if (!worker_running_.load()) {
        return;
      }

      // Drain everything available before going back to wait. WinTun's
      // read-wait event is auto-reset on signal, so we must consume all
      // queued packets before re-arming.
      bool drained = false;
      while (worker_running_.load() && !receive_paused_.load()) {
        DWORD packet_size = 0;
        BYTE* packet = api.ReceivePacket(session_, &packet_size);
        if (packet) {
          const size_t copy_len = static_cast<size_t>(packet_size) > buffer_size
                                      ? buffer_size
                                      : static_cast<size_t>(packet_size);
          std::vector<uint8_t> data(packet, packet + copy_len);
          api.ReleaseReceivePacket(session_, packet);
          if (on_packet && !on_packet(std::move(data))) {
            break;
          }
          continue;
        }

        DWORD err = ::GetLastError();
        if (err == ERROR_NO_MORE_ITEMS) {
          drained = true;
          break;
        }
        if (err == ERROR_HANDLE_EOF) {
          if (on_error) {
            on_error("WinTun adapter terminating");
          }
          worker_running_.store(false);
          return;
        }
        if (on_error) {
          on_error("WintunReceivePacket failed: " + FormatLastError(err));
        }
        worker_running_.store(false);
        return;
      }

      if (!worker_running_.load()) {
        return;
      }
      if (!drained) {
        continue;
      }

      DWORD wait = ::WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
      if (wait == WAIT_OBJECT_0 + 1) {
        // quit_event signalled.
        return;
      }
      if (wait != WAIT_OBJECT_0) {
        if (on_error) {
          on_error("WaitForMultipleObjects failed: " + FormatLastError(::GetLastError()));
        }
        return;
      }
    }
  }

  WINTUN_ADAPTER_HANDLE adapter_ = nullptr;
  WINTUN_SESSION_HANDLE session_ = nullptr;
  HANDLE read_event_ = nullptr; // Owned by `session_`; do not CloseHandle.
  Handle quit_event_;
  std::thread worker_;
  std::atomic<bool> worker_running_{false};
  std::atomic<bool> receive_paused_{false};
  std::string interface_name_;
};

} // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() {
  return std::make_unique<WindowsTunBackend>();
}

#endif
