#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#include <BaseTsd.h>
using ssize_t = SSIZE_T;
#else
#include <sys/types.h>
#endif

#include <uv.h>

enum class ReadPacketStatus {
  Data,
  NoData,
  Closed,
  Error,
};

// Backend abstraction that hides OS-specific TUN device handling from the N-API
// surface. Each backend owns its native handle (POSIX file descriptor or Win32
// HANDLE) and the receive-loop primitive it needs (libuv `uv_poll_t` for POSIX,
// dedicated worker thread + Win32 event for Windows).
class TunPlatformBackend {
public:
  // Invoked once per packet read by the receive loop. Always called on a
  // background thread (libuv loop thread on POSIX, worker thread on Windows);
  // the caller in `tuntap.cc` is responsible for marshalling onto the JS
  // thread via `Napi::ThreadSafeFunction`.
  using PacketCallback = std::function<void(std::vector<uint8_t>)>;

  // Invoked at most once when the receive loop encounters a fatal error and
  // stops. The receive loop must not deliver any further packets afterwards.
  using ErrorCallback = std::function<void(const std::string&)>;

  virtual ~TunPlatformBackend() = default;

  virtual bool OpenDevice(const std::string& requested_name,
                          std::string& out_interface_name,
                          std::string& error) = 0;
  virtual void CloseDevice() = 0;
  virtual bool IsOpen() const = 0;

  virtual ReadPacketStatus ReadPacket(size_t max_payload_size,
                                      std::vector<uint8_t>& out,
                                      std::string& error) = 0;
  virtual ssize_t WritePacket(const uint8_t* data,
                              size_t length,
                              std::string& error) = 0;

  // Begin asynchronous packet delivery. `loop` is supplied by Node-API and is
  // used by POSIX backends for `uv_poll_init`; Windows ignores it.
  virtual bool StartReceiveLoop(uv_loop_t* loop,
                                size_t buffer_size,
                                PacketCallback on_packet,
                                ErrorCallback on_error,
                                std::string& error) = 0;
  virtual void StopReceiveLoop() = 0;

  // Returns the underlying POSIX file descriptor when one exists. Backends
  // without a numeric fd (e.g. Wintun on Windows) return `-1`.
  virtual int GetNativeFd() const { return -1; }
};

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();
