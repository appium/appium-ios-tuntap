#ifdef __linux__

#include "tun_backend.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <linux/if.h>
#include <linux/if_tun.h>

namespace {

class LinuxTunBackend : public TunPlatformBackend {
public:
  bool OpenDevice(const std::string& requested_name, OpenResult& out, std::string& error) override {
    struct stat statbuf;
    if (stat("/dev/net/tun", &statbuf) != 0) {
      error =
        "TUN/TAP device not available: /dev/net/tun does not exist. "
        "Please ensure the TUN/TAP kernel module is loaded (modprobe tun).";
      return false;
    }

    FileDescriptor temp_fd(open("/dev/net/tun", O_RDWR));
    if (!temp_fd.is_valid()) {
      error =
        std::string("Failed to open /dev/net/tun: ") + strerror(errno) +
        ". This usually means you don't have sufficient permissions. "
        "Try running with sudo or add your user to the 'tun' group.";
      return false;
    }

    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;

    if (!requested_name.empty()) {
      strncpy(ifr.ifr_name, requested_name.c_str(), IFNAMSIZ - 1);
      ifr.ifr_name[IFNAMSIZ - 1] = '\0';
    }

    if (ioctl(temp_fd.get(), TUNSETIFF, &ifr) < 0) {
      error = std::string("Failed to configure TUN device: ") + strerror(errno);
      return false;
    }

    out.fd = std::move(temp_fd);
    out.interface_name = std::string(ifr.ifr_name);
    return true;
  }

  ssize_t ReadPacket(int fd, size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) override {
    out.resize(max_payload_size);
    ssize_t bytes_read = read(fd, out.data(), out.size());
    if (bytes_read < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        out.clear();
        return 0;
      }
      error = std::string("Read error: ") + strerror(errno);
      return -1;
    }

    out.resize(static_cast<size_t>(bytes_read));
    return bytes_read;
  }

  ssize_t WritePacket(int fd, const uint8_t* data, size_t length, std::string& error) override {
    ssize_t bytes_written = write(fd, data, length);
    if (bytes_written < 0) {
      error = std::string("Write error: ") + strerror(errno);
      return -1;
    }
    return bytes_written;
  }
};

} // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformTunBackend() {
  return std::make_unique<LinuxTunBackend>();
}

#endif

