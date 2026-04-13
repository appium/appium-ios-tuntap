#include <napi.h>
#include <unistd.h>
#include <fcntl.h>
#include <string>
#include <string.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <vector>
#include <memory>
#include <mutex>
#include <atomic>
#include <cstdio>
#include <uv.h>

#ifdef __APPLE__
#include <sys/kern_control.h>
#include <sys/socket.h>
#include <sys/sys_domain.h>
#include <net/if_utun.h>
#include <netinet/in.h>
#include <netinet6/in6_var.h>
#define UTUN_CONTROL_NAME "com.apple.net.utun_control"
#else
#include <linux/if.h>
#include <linux/if_tun.h>
#include <sys/stat.h>
#endif

// RAII wrapper for file descriptors
class FileDescriptor {
private:
  int fd_;

public:
  FileDescriptor() : fd_(-1) {}
  explicit FileDescriptor(int fd) : fd_(fd) {}

  ~FileDescriptor() {
    if (fd_ >= 0) {
      ::close(fd_);
    }
  }

  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;

  FileDescriptor(FileDescriptor&& other) noexcept : fd_(other.fd_) {
    other.fd_ = -1;
  }

  FileDescriptor& operator=(FileDescriptor&& other) noexcept {
    if (this != &other) {
      if (fd_ >= 0) {
        ::close(fd_);
      }
      fd_ = other.fd_;
      other.fd_ = -1;
    }
    return *this;
  }

  int get() const { return fd_; }

  int release() {
    int temp = fd_;
    fd_ = -1;
    return temp;
  }

  bool is_valid() const { return fd_ >= 0; }

  void reset(int fd = -1) {
    if (fd_ >= 0) {
      ::close(fd_);
    }
    fd_ = fd;
  }
};

struct OpenResult {
  FileDescriptor fd;
  std::string interface_name;
};

class TunPlatformBackend {
public:
  virtual ~TunPlatformBackend() = default;
  virtual bool OpenDevice(const std::string& requested_name, OpenResult& out, std::string& error) = 0;
  virtual ssize_t ReadPacket(int fd, size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) = 0;
  virtual ssize_t WritePacket(int fd, const uint8_t* data, size_t length, std::string& error) = 0;
};

static bool SetNonBlocking(int fd, std::string& error);
static std::unique_ptr<TunPlatformBackend> CreatePlatformBackend();

class TunDevice : public Napi::ObjectWrap<TunDevice> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  TunDevice(const Napi::CallbackInfo& info);
  ~TunDevice();

  void CloseInternal();

private:
  static Napi::FunctionReference constructor;

  Napi::Value Open(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Read(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value GetName(const Napi::CallbackInfo& info);
  Napi::Value GetFd(const Napi::CallbackInfo& info);
  Napi::Value StartPolling(const Napi::CallbackInfo& info);

  FileDescriptor fd_;
  std::string name_;
  std::unique_ptr<TunPlatformBackend> backend_;
  std::atomic<bool> is_open_;
  std::mutex device_mutex_;

  uv_poll_t* poll_handle_ = nullptr;
  Napi::ThreadSafeFunction tsfn_;
  static constexpr size_t MAX_POLL_BUFFER = 65535;
  size_t poll_buffer_size_ = MAX_POLL_BUFFER;

  void StopPolling();
  static void PollCallback(uv_poll_t* handle, int status, int events);
};

Napi::FunctionReference TunDevice::constructor;

// #region Public N-API interface

Napi::Object TunDevice::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);

  Napi::Function func = DefineClass(env, "TunDevice", {
    InstanceMethod("open", &TunDevice::Open),
    InstanceMethod("close", &TunDevice::Close),
    InstanceMethod("read", &TunDevice::Read),
    InstanceMethod("write", &TunDevice::Write),
    InstanceMethod("getName", &TunDevice::GetName),
    InstanceMethod("getFd", &TunDevice::GetFd),
    InstanceMethod("startPolling", &TunDevice::StartPolling),
  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("TunDevice", func);
  return exports;
}

TunDevice::TunDevice(const Napi::CallbackInfo& info)
  : Napi::ObjectWrap<TunDevice>(info), backend_(CreatePlatformBackend()), is_open_(false) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (info.Length() > 0 && info[0].IsString()) {
    name_ = info[0].As<Napi::String>().Utf8Value();
  }
}

TunDevice::~TunDevice() {
  std::lock_guard<std::mutex> lock(device_mutex_);
  CloseInternal();
}

Napi::Value TunDevice::Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (is_open_) {
    return Napi::Boolean::New(env, true);
  }

  OpenResult result;
  std::string error;
  if (!backend_->OpenDevice(name_, result, error)) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  if (!SetNonBlocking(result.fd.get(), error)) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  fd_ = std::move(result.fd);
  name_ = result.interface_name;
  is_open_ = true;

  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);
  CloseInternal();
  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !fd_.is_valid()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t buffer_size = 4096;
  if (info.Length() > 0 && info[0].IsNumber()) {
    buffer_size = info[0].As<Napi::Number>().Uint32Value();
    if (buffer_size == 0 || buffer_size > MAX_POLL_BUFFER) {
      Napi::RangeError::New(env, "Read buffer size must be between 1 and " + std::to_string(MAX_POLL_BUFFER)).ThrowAsJavaScriptException();
      return env.Null();
    }
  }

  std::vector<uint8_t> packet;
  std::string error;
  ssize_t bytes_read = backend_->ReadPacket(fd_.get(), buffer_size, packet, error);
  if (bytes_read < 0) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (bytes_read == 0) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }

  return Napi::Buffer<uint8_t>::Copy(env, packet.data(), static_cast<size_t>(bytes_read));
}

Napi::Value TunDevice::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !fd_.is_valid()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected buffer as first argument").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
  uint8_t* data = buffer.Data();
  size_t length = buffer.Length();

  std::string error;
  ssize_t bytes_written = backend_->WritePacket(fd_.get(), data, length, error);
  if (bytes_written < 0) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }
  return Napi::Number::New(env, bytes_written);
}

Napi::Value TunDevice::GetName(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::String::New(info.Env(), name_);
}

Napi::Value TunDevice::GetFd(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::Number::New(info.Env(), fd_.get());
}

Napi::Value TunDevice::StartPolling(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !fd_.is_valid()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected function as first argument").ThrowAsJavaScriptException();
    return env.Null();
  }

  StopPolling();

  // Optional buffer size as second argument (default: MAX_POLL_BUFFER)
  poll_buffer_size_ = MAX_POLL_BUFFER;
  if (info.Length() > 1 && info[1].IsNumber()) {
    auto size = info[1].As<Napi::Number>().Uint32Value();
    if (size == 0 || size > MAX_POLL_BUFFER) {
      Napi::RangeError::New(env, "Buffer size must be between 1 and " + std::to_string(MAX_POLL_BUFFER)).ThrowAsJavaScriptException();
      return env.Null();
    }
    poll_buffer_size_ = size;
  }

  tsfn_ = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "TunDeviceDataCallback",
    0,
    1
  );

  uv_loop_t* loop = nullptr;
  napi_status napi_st = napi_get_uv_event_loop(env, &loop);
  if (napi_st != napi_ok || loop == nullptr) {
    tsfn_.Release();
    tsfn_ = nullptr;
    Napi::Error::New(env, "Failed to acquire event loop").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto handle = std::make_unique<uv_poll_t>();
  if (uv_poll_init(loop, handle.get(), fd_.get()) != 0) {
    tsfn_.Release();
    tsfn_ = nullptr;
    Napi::Error::New(env, "Failed to initialize poll handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  handle->data = this;
  if (uv_poll_start(handle.get(), UV_READABLE, PollCallback) != 0) {
    // Properly close the initialized-but-not-started handle
    uv_close(reinterpret_cast<uv_handle_t*>(handle.release()), [](uv_handle_t* h) {
      delete reinterpret_cast<uv_poll_t*>(h);
    });
    tsfn_.Release();
    tsfn_ = nullptr;
    Napi::Error::New(env, "Failed to start polling").ThrowAsJavaScriptException();
    return env.Null();
  }

  poll_handle_ = handle.release();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return TunDevice::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)
// #endregion

// #region Private implementation details

void TunDevice::CloseInternal() {
  if (is_open_.exchange(false)) {
    StopPolling();
    fd_.reset();
  }
}

void TunDevice::StopPolling() {
  if (poll_handle_) {
    uv_poll_stop(poll_handle_);
    // Must use uv_close before freeing a libuv handle
    uv_close(reinterpret_cast<uv_handle_t*>(poll_handle_), [](uv_handle_t* handle) {
      delete reinterpret_cast<uv_poll_t*>(handle);
    });
    poll_handle_ = nullptr;
  }
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
}

void TunDevice::PollCallback(uv_poll_t* handle, int status, int events) {
  if (status < 0) {
    fprintf(stderr, "tuntap poll error: %s\n", uv_strerror(status));
    auto* self = static_cast<TunDevice*>(handle->data);
    if (self) {
      self->StopPolling();
    }
    return;
  }

  if (!(events & UV_READABLE)) {
    return;
  }

  auto* self = static_cast<TunDevice*>(handle->data);
  if (!self || !self->is_open_.load() || !self->fd_.is_valid()) {
    return;
  }

  std::vector<uint8_t> packet;
  std::string error;
  ssize_t bytes_read = self->backend_->ReadPacket(self->fd_.get(), self->poll_buffer_size_, packet, error);
  if (bytes_read < 0) {
    fprintf(stderr, "tuntap read error: %s\n", error.c_str());
    self->StopPolling();
    return;
  }
  if (bytes_read == 0) {
    return;
  }

  self->tsfn_.BlockingCall(
    [packet = std::move(packet)](Napi::Env env, Napi::Function jsCallback) {
      if (env == nullptr || jsCallback.IsEmpty()) return;
      jsCallback.Call({ Napi::Buffer<uint8_t>::Copy(env, packet.data(), packet.size()) });
    }
  );
}

static bool IsWouldBlock() {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static bool SetNonBlocking(int fd, std::string& error) {
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

#ifdef __APPLE__
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

  ssize_t ReadPacket(int fd, size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) override {
    std::vector<uint8_t> frame(max_payload_size + kUtunHeaderSize);
    ssize_t bytes_read = read(fd, frame.data(), frame.size());
    if (bytes_read < 0) {
      if (IsWouldBlock()) {
        out.clear();
        return 0;
      }
      error = std::string("Read error: ") + strerror(errno);
      return -1;
    }
    if (bytes_read <= static_cast<ssize_t>(kUtunHeaderSize)) {
      out.clear();
      return 0;
    }

    const auto payload_len = static_cast<size_t>(bytes_read - kUtunHeaderSize);
    out.resize(payload_len);
    memcpy(out.data(), frame.data() + kUtunHeaderSize, payload_len);
    return static_cast<ssize_t>(payload_len);
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
      return std::stoi(requested_name.substr(4)) + 1; // Kernel maps utun0 -> unit 1
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
#else
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
      if (IsWouldBlock()) {
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
#endif

static std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() {
#ifdef __APPLE__
  return std::make_unique<DarwinTunBackend>();
#else
  return std::make_unique<LinuxTunBackend>();
#endif
}
// #endregion
