#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <string>
#include <utility>
#include <vector>

#include "file_descriptor.h"
#include "posix_uv_poll_loop.h"
#include "tun_backend.h"

// Shared base class for POSIX TUN backends (Darwin, Linux). Owns the file
// descriptor, the assigned interface name, and the libuv poll loop. Concrete
// subclasses implement only the platform-specific OpenDevice, ReadPacket, and
// WritePacket.
class PosixTunBackend : public TunPlatformBackend {
public:
  void CloseDevice() override {
    poll_loop_.Stop();
    fd_.reset();
    interface_name_.clear();
  }

  bool IsOpen() const override { return fd_.is_valid(); }

  bool StartReceiveLoop(uv_loop_t* loop,
                        size_t buffer_size,
                        PacketCallback on_packet,
                        ErrorCallback on_error,
                        std::string& error) override {
    if (!fd_.is_valid()) {
      error = "Device not open";
      return false;
    }
    return poll_loop_.Start(
        loop,
        fd_.get(),
        buffer_size,
        [this](size_t size, std::vector<uint8_t>& out, std::string& err) {
          return ReadPacket(size, out, err);
        },
        std::move(on_packet),
        std::move(on_error),
        error);
  }

  void StopReceiveLoop() override { poll_loop_.Stop(); }

  int GetNativeFd() const override { return fd_.get(); }

protected:
  FileDescriptor fd_;
  std::string interface_name_;
  PosixUvPollLoop poll_loop_;
};

#endif
