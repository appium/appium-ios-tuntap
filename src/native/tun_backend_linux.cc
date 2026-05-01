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

#include <utility>

#include "file_descriptor.h"
#include "posix_uv_poll_loop.h"

namespace {
constexpr const char* kTunDevicePath = "/dev/net/tun";

class LinuxTunBackend : public TunPlatformBackend {
public:
  bool OpenDevice(const std::string& requested_name,
                  std::string& out_interface_name,
                  std::string& error) override {
    struct stat statbuf;
    if (stat(kTunDevicePath, &statbuf) != 0) {
      error =
          "TUN/TAP device not available: /dev/net/tun does not exist. "
          "Please ensure the TUN/TAP kernel module is loaded (modprobe tun).";
      return false;
    }

    FileDescriptor temp_fd(open(kTunDevicePath, O_RDWR));
    if (!temp_fd.is_valid()) {
      error =
          std::string("Failed to open ") + kTunDevicePath + ": " + strerror(errno) +
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

    if (!SetNonBlocking(temp_fd.get(), error)) {
      return false;
    }

    fd_ = std::move(temp_fd);
    interface_name_ = std::string(ifr.ifr_name);
    out_interface_name = interface_name_;
    return true;
  }

  void CloseDevice() override {
    poll_loop_.Stop();
    fd_.reset();
    interface_name_.clear();
  }

  bool IsOpen() const override { return fd_.is_valid(); }

  ReadPacketStatus ReadPacket(size_t max_payload_size,
                              std::vector<uint8_t>& out,
                              std::string& error) override {
    if (!fd_.is_valid()) {
      error = "Device not open";
      return ReadPacketStatus::Error;
    }

    out.resize(max_payload_size);
    ssize_t bytes_read = read(fd_.get(), out.data(), out.size());
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

    out.resize(static_cast<size_t>(bytes_read));
    return ReadPacketStatus::Data;
  }

  ssize_t WritePacket(const uint8_t* data,
                      size_t length,
                      std::string& error) override {
    if (!fd_.is_valid()) {
      error = "Device not open";
      return -1;
    }
    ssize_t bytes_written = write(fd_.get(), data, length);
    if (bytes_written < 0) {
      error = std::string("Write error: ") + strerror(errno);
      return -1;
    }
    return bytes_written;
  }

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

private:
  FileDescriptor fd_;
  std::string interface_name_;
  PosixUvPollLoop poll_loop_;
};

} // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() {
  return std::make_unique<LinuxTunBackend>();
}

#endif
