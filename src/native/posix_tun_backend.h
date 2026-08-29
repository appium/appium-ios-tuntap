#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>

#include <string>

#include "file_descriptor.h"
#include "tun_backend.h"

/** Sets O_NONBLOCK on `fd`; fills `error` and returns false on failure. */
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

// Shared base class for POSIX TUN backends (Darwin, Linux). Owns the file
// descriptor and the assigned interface name. Concrete subclasses implement
// only the platform-specific OpenDevice, ReadPacket, and WritePacket.
class PosixTunBackend : public TunPlatformBackend {
 public:
  void CloseDevice() override {
    fd_.reset();
    interface_name_.clear();
  }

  [[nodiscard]] bool IsOpen() const override { return fd_.is_valid(); }

  [[nodiscard]] int GetNativeFd() const override { return fd_.get(); }

  bool WaitReadable(const std::atomic<bool>& running, std::string& error) override {
    return WaitForEvents(POLLIN, running, error);
  }

  bool WaitWritable(const std::atomic<bool>& running, std::string& error) override {
    return WaitForEvents(POLLOUT, running, error);
  }

 protected:
  FileDescriptor fd_;
  std::string interface_name_;

 private:
  bool WaitForEvents(short events, const std::atomic<bool>& running, std::string& error) {
    if (!fd_.is_valid()) {
      error = "Device not open";
      return false;
    }

    struct pollfd pfd {};
    pfd.fd = fd_.get();
    pfd.events = events;

    while (running.load()) {
      const int rc = poll(&pfd, 1, 200);
      if (rc > 0) {
        if ((pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
          error = "TUN device poll failed";
          return false;
        }
        return (pfd.revents & events) != 0;
      }
      if (rc == 0 || errno == EINTR) {
        continue;
      }
      error = "TUN device poll failed";
      return false;
    }

    return false;
  }
};

#endif
