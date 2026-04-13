#include "tun_backend.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>

std::unique_ptr<TunPlatformBackend> CreatePlatformTunBackend();

bool SetNonBlocking(int fd, std::string& error) {
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

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() {
  return CreatePlatformTunBackend();
}

