#pragma once

#if !defined(__linux__) && !defined(__APPLE__) && !defined(_WIN32)
#error "appium-ios-tuntap native addon supports only Linux, macOS, and Windows"
#endif

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#ifdef _WIN32
#include <BaseTsd.h>
using ssize_t = SSIZE_T;
#else
#include <sys/types.h>
#endif

enum class ReadPacketStatus : std::uint8_t {
  Data,
  NoData,
  Closed,
  Error,
};

/**
 * Backend abstraction that hides OS-specific TUN device handling from the
 * N-API surface. Each backend owns its native handle (POSIX file descriptor
 * or WinTun session).
 */
class TunPlatformBackend {
 public:
  virtual ~TunPlatformBackend() = default;

  virtual bool OpenDevice(const std::string& requested_name, std::string& out_interface_name, std::string& error) = 0;
  virtual void CloseDevice() = 0;
  [[nodiscard]] virtual bool IsOpen() const = 0;

  virtual ReadPacketStatus ReadPacket(size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) = 0;
  virtual ssize_t WritePacket(const uint8_t* data, size_t length, std::string& error) = 0;

  // Block until a packet can be read/written or `running` becomes false.
  // Implementations may use short timed waits when the platform does not expose
  // an explicit writable event.
  virtual bool WaitReadable(const std::atomic<bool>& running, std::string& error) = 0;
  virtual bool WaitWritable(const std::atomic<bool>& running, std::string& error) = 0;

  // Returns the underlying POSIX file descriptor when one exists. Backends
  // without a numeric fd (e.g. Wintun on Windows) return `-1`.
  [[nodiscard]] virtual int GetNativeFd() const { return -1; }
};

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();
