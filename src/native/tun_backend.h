#pragma once

#if !defined(__linux__) && !defined(__APPLE__)
#error "appium-ios-tuntap native addon supports only Linux and macOS"
#endif

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <sys/types.h>
#include <vector>
#include <fcntl.h>
#include <errno.h>
#include <string.h>

#include "file_descriptor.h"

inline bool SetNonBlocking(int fd, std::string& error) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    error = std::string("Failed to get file descriptor flags: ") + strerror(errno);
    return false;
  }
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    error = std::string("Failed to set non-blocking mode: ") + strerror(errno);
    return false;
  }
  return true;
}

struct OpenResult {
  FileDescriptor fd;
  std::string interface_name;
};

enum class ReadPacketStatus {
  Data,
  NoData,
  Closed,
  Error,
};

class TunPlatformBackend {
public:
  virtual ~TunPlatformBackend() = default;
  virtual bool OpenDevice(const std::string& requested_name, OpenResult& out, std::string& error) = 0;
  virtual ReadPacketStatus ReadPacket(int fd, size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) = 0;
  virtual ssize_t WritePacket(int fd, const uint8_t* data, size_t length, std::string& error) = 0;
};

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();

