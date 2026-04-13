#ifdef __APPLE__

#include "tun_backend.h"

#include <errno.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/kern_control.h>
#include <sys/socket.h>
#include <sys/sys_domain.h>
#include <unistd.h>

#include <net/if_utun.h>
#include <netinet/in.h>
#include <netinet6/in6_var.h>

#define UTUN_CONTROL_NAME "com.apple.net.utun_control"

namespace {

class DarwinTunBackend : public TunPlatformBackend {
public:
  static constexpr size_t kUtunHeaderSize = 4;

  bool OpenDevice(const std::string& requested_name, OpenResult& out, std::string& error) override {
    struct ctl_info ctl_info;
    struct sockaddr_ctl socket_addr;

    FileDescriptor temp_fd(socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL));
    if (!temp_fd.is_valid()) {
      error = std::string("Failed to create control socket: ") + strerror(errno);
      return false;
    }

    memset(&ctl_info, 0, sizeof(ctl_info));
    strncpy(ctl_info.ctl_name, UTUN_CONTROL_NAME, sizeof(ctl_info.ctl_name) - 1);
    ctl_info.ctl_name[sizeof(ctl_info.ctl_name) - 1] = '\0';

    if (ioctl(temp_fd.get(), CTLIOCGINFO, &ctl_info) < 0) {
      error = std::string("Failed to get utun control info: ") + strerror(errno);
      return false;
    }

    memset(&socket_addr, 0, sizeof(socket_addr));
    socket_addr.sc_len = sizeof(socket_addr);
    socket_addr.sc_family = AF_SYSTEM;
    socket_addr.ss_sysaddr = SYSPROTO_CONTROL;
    socket_addr.sc_id = ctl_info.ctl_id;

    int utun_unit = ParseRequestedUtunUnit(requested_name);
    if (utun_unit > 0) {
      socket_addr.sc_unit = utun_unit;
      if (connect(temp_fd.get(), reinterpret_cast<struct sockaddr*>(&socket_addr), sizeof(socket_addr)) < 0) {
        error = std::string("Failed to connect to utun with specified unit: ") + strerror(errno);
        return false;
      }
    } else if (!ConnectFirstAvailableUnit(temp_fd.get(), socket_addr, error)) {
      return false;
    }

    char interface_name[20];
    socklen_t interface_name_len = sizeof(interface_name);
    if (getsockopt(temp_fd.get(), SYSPROTO_CONTROL, UTUN_OPT_IFNAME, interface_name, &interface_name_len) < 0) {
      error = std::string("Failed to get utun interface name: ") + strerror(errno);
      return false;
    }

    out.fd = std::move(temp_fd);
    out.interface_name = std::string(interface_name);
    return true;
  }

  ReadPacketStatus ReadPacket(int fd, size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) override {
    std::vector<uint8_t> frame(max_payload_size + kUtunHeaderSize);
    ssize_t bytes_read = read(fd, frame.data(), frame.size());
    if (bytes_read < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        out.clear();
        return ReadPacketStatus::NoData;
      }
      error = std::string("Read error: ") + strerror(errno);
      return ReadPacketStatus::Error;
    }
    if (bytes_read == 0) {
      out.clear();
      return ReadPacketStatus::Closed;
    }
    if (bytes_read <= static_cast<ssize_t>(kUtunHeaderSize)) {
      out.clear();
      return ReadPacketStatus::NoData;
    }

    const auto payload_len = static_cast<size_t>(bytes_read - kUtunHeaderSize);
    out.resize(payload_len);
    memcpy(out.data(), frame.data() + kUtunHeaderSize, payload_len);
    return ReadPacketStatus::Data;
  }

  ssize_t WritePacket(int fd, const uint8_t* data, size_t length, std::string& error) override {
    std::vector<uint8_t> frame(length + kUtunHeaderSize);
    uint32_t family = htonl(AF_INET6);
    memcpy(frame.data(), &family, kUtunHeaderSize);
    memcpy(frame.data() + kUtunHeaderSize, data, length);

    ssize_t bytes_written = write(fd, frame.data(), frame.size());
    if (bytes_written < 0) {
      error = std::string("Write error: ") + strerror(errno);
      return -1;
    }

    return bytes_written > static_cast<ssize_t>(kUtunHeaderSize)
      ? bytes_written - static_cast<ssize_t>(kUtunHeaderSize)
      : 0;
  }

private:
  static int ParseRequestedUtunUnit(const std::string& requested_name) {
    if (requested_name.empty() || requested_name.find("utun") != 0) {
      return 0;
    }
    try {
      return std::stoi(requested_name.substr(4)) + 1;
    } catch (...) {
      return 0;
    }
  }

  static bool ConnectFirstAvailableUnit(int fd, struct sockaddr_ctl& socket_addr, std::string& error) {
    for (socket_addr.sc_unit = 1; socket_addr.sc_unit < 255; socket_addr.sc_unit++) {
      if (connect(fd, reinterpret_cast<struct sockaddr*>(&socket_addr), sizeof(socket_addr)) == 0) {
        return true;
      }
      if (errno != EBUSY) {
        error = std::string("Failed to connect to utun control socket: ") + strerror(errno);
        return false;
      }
    }

    error = "Could not find an available utun device";
    return false;
  }
};

} // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformTunBackend() {
  return std::make_unique<DarwinTunBackend>();
}

#endif

