#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <sys/types.h>
#include <vector>

#include "file_descriptor.h"

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

bool SetNonBlocking(int fd, std::string& error);
std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();

