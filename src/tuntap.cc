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
#include <csignal>
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

// Global state for signal handling
static std::atomic<bool> g_shutdown_requested(false);
static std::mutex g_devices_mutex;
static std::vector<class TunDevice*> g_active_devices;

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

  // Disable copy
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;

  // Enable move
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

class TunDevice : public Napi::ObjectWrap<TunDevice> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  TunDevice(const Napi::CallbackInfo& info);
  ~TunDevice();

private:
  static Napi::FunctionReference constructor;
  static std::once_flag signal_handler_flag;

public:
  void CloseInternal();

private:
  Napi::Value Open(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Read(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value GetName(const Napi::CallbackInfo& info);
  Napi::Value GetFd(const Napi::CallbackInfo& info);
  Napi::Value StartPolling(const Napi::CallbackInfo& info);

  FileDescriptor fd_;
  std::string name_;
  std::atomic<bool> is_open_;
  std::mutex device_mutex_;

  uv_poll_t* poll_handle_ = nullptr;
  Napi::ThreadSafeFunction tsfn_;

  void RegisterDevice();
  void UnregisterDevice();
  void StopPolling();
  static void PollCallback(uv_poll_t* handle, int status, int events);
};

Napi::FunctionReference TunDevice::constructor;

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
  : Napi::ObjectWrap<TunDevice>(info), is_open_(false) {
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

void TunDevice::RegisterDevice() {
  std::lock_guard<std::mutex> lock(g_devices_mutex);
  g_active_devices.push_back(this);
}

void TunDevice::UnregisterDevice() {
  std::lock_guard<std::mutex> lock(g_devices_mutex);
  g_active_devices.erase(
    std::remove(g_active_devices.begin(), g_active_devices.end(), this),
    g_active_devices.end()
  );
}

void TunDevice::CloseInternal() {
  if (is_open_.exchange(false)) {
    StopPolling();
    fd_.reset();
  }
}

Napi::Value TunDevice::Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (is_open_) {
    return Napi::Boolean::New(env, true);
  }

  if (g_shutdown_requested.load()) {
    Napi::Error::New(env, "Shutdown in progress").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

#ifdef __APPLE__
  // macOS implementation using utun interfaces
  struct ctl_info ctlInfo;
  struct sockaddr_ctl sc;

  FileDescriptor temp_fd(socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL));
  if (!temp_fd.is_valid()) {
    std::string error = "Failed to create control socket: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&ctlInfo, 0, sizeof(ctlInfo));
  strncpy(ctlInfo.ctl_name, UTUN_CONTROL_NAME, sizeof(ctlInfo.ctl_name) - 1);
  ctlInfo.ctl_name[sizeof(ctlInfo.ctl_name) - 1] = '\0';

  if (ioctl(temp_fd.get(), CTLIOCGINFO, &ctlInfo) < 0) {
    std::string error = "Failed to get utun control info: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&sc, 0, sizeof(sc));
  sc.sc_len = sizeof(sc);
  sc.sc_family = AF_SYSTEM;
  sc.ss_sysaddr = SYSPROTO_CONTROL;
  sc.sc_id = ctlInfo.ctl_id;

  // Parse utun number if provided, otherwise use a default (utun0 = unit 1)
  int utun_unit = 0;
  if (!name_.empty() && name_.find("utun") == 0) {
    try {
      utun_unit = std::stoi(name_.substr(4)) + 1; // +1 because kernel uses unit=1 for utun0
    } catch(...) {
      utun_unit = 0;
    }
  }

  if (utun_unit > 0) {
    sc.sc_unit = utun_unit;
    // Try to connect with the specified unit
    if (connect(temp_fd.get(), (struct sockaddr*)&sc, sizeof(sc)) < 0) {
      std::string error = "Failed to connect to utun control socket with specified unit: ";
      error += strerror(errno);
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return Napi::Boolean::New(env, false);
    }
  } else {
    // Find the first available unit
    bool connected = false;
    for (sc.sc_unit = 1; sc.sc_unit < 255; sc.sc_unit++) {
      if (connect(temp_fd.get(), (struct sockaddr*)&sc, sizeof(sc)) == 0) {
        connected = true;
        break;
      } else if (errno != EBUSY) {
        std::string error = "Failed to connect to utun control socket: ";
        error += strerror(errno);
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
      }
    }

    if (!connected) {
      Napi::Error::New(env, "Could not find an available utun device").ThrowAsJavaScriptException();
      return Napi::Boolean::New(env, false);
    }
  }

  // Get the utun device name
  char utunname[20];
  socklen_t utunname_len = sizeof(utunname);
  if (getsockopt(temp_fd.get(), SYSPROTO_CONTROL, UTUN_OPT_IFNAME, utunname, &utunname_len) < 0) {
    std::string error = "Failed to get utun interface name: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name_ = std::string(utunname);

#else
  // Linux implementation using TUN/TAP
  // First check if /dev/net/tun exists
  struct stat statbuf;
  if (stat("/dev/net/tun", &statbuf) != 0) {
    std::string error = "TUN/TAP device not available: /dev/net/tun does not exist. ";
    error += "Please ensure the TUN/TAP kernel module is loaded (modprobe tun).";
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  FileDescriptor temp_fd(open("/dev/net/tun", O_RDWR));
  if (!temp_fd.is_valid()) {
    std::string error = "Failed to open /dev/net/tun: ";
    error += strerror(errno);
    error += ". This usually means you don't have sufficient permissions. ";
    error += "Try running with sudo or add your user to the 'tun' group.";
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));

  // Set flags - IFF_TUN for TUN device, IFF_NO_PI to not provide packet info
  ifr.ifr_flags = IFF_TUN | IFF_NO_PI;

  // If name is provided, use it
  if (!name_.empty()) {
    strncpy(ifr.ifr_name, name_.c_str(), IFNAMSIZ - 1);
    ifr.ifr_name[IFNAMSIZ - 1] = '\0';
  }

  if (ioctl(temp_fd.get(), TUNSETIFF, &ifr) < 0) {
    std::string error = "Failed to configure TUN device: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name_ = std::string(ifr.ifr_name);
#endif

  // Set non-blocking mode
  int flags = fcntl(temp_fd.get(), F_GETFL, 0);
  if (flags < 0) {
    std::string error = "Failed to get file descriptor flags: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  if (fcntl(temp_fd.get(), F_SETFL, flags | O_NONBLOCK) < 0) {
    std::string error = "Failed to set non-blocking mode: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  // Transfer ownership to member variable
  fd_ = std::move(temp_fd);
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

  if (g_shutdown_requested.load()) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }

  // Read buffer size
  size_t buffer_size = 4096; // Default
  if (info.Length() > 0 && info[0].IsNumber()) {
    buffer_size = info[0].As<Napi::Number>().Uint32Value();
  }

  // Create buffer for reading
  Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::New(env, buffer_size);
  uint8_t* data = buffer.Data();

#ifdef __APPLE__
  // On macOS, reads include a 4-byte protocol family prefix
  // We'll read the packet and then remove this prefix
  std::vector<uint8_t> tmp_buffer(buffer_size + 4);

  ssize_t bytes_read = read(fd_.get(), tmp_buffer.data(), buffer_size + 4);
  if (bytes_read <= 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // No data available
      return Napi::Buffer<uint8_t>::New(env, 0);
    }

    // Error occurred
    std::string error = "Read error: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }

  // Skip the 4-byte protocol family header
  if (bytes_read > 4) {
    memcpy(data, tmp_buffer.data() + 4, bytes_read - 4);
    return Napi::Buffer<uint8_t>::Copy(env, data, bytes_read - 4);
  } else {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
#else
  // On Linux, we read directly into the buffer
  ssize_t bytes_read = read(fd_.get(), data, buffer_size);
  if (bytes_read < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // No data available
      return Napi::Buffer<uint8_t>::New(env, 0);
    }

    // Error occurred
    std::string error = "Read error: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Buffer<uint8_t>::Copy(env, data, bytes_read);
#endif
}

Napi::Value TunDevice::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !fd_.is_valid()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  if (g_shutdown_requested.load()) {
    Napi::Error::New(env, "Shutdown in progress").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected buffer as first argument").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
  uint8_t* data = buffer.Data();
  size_t length = buffer.Length();

#ifdef __APPLE__
  // On macOS, we need to prepend a 4-byte protocol family header
  // For IPv6, the protocol family is AF_INET6 (30 on macOS)
  std::vector<uint8_t> tmp_buffer(length + 4);
  uint32_t family = htonl(AF_INET6);

  memcpy(tmp_buffer.data(), &family, 4);
  memcpy(tmp_buffer.data() + 4, data, length);

  ssize_t bytes_written = write(fd_.get(), tmp_buffer.data(), length + 4);
  if (bytes_written < 0) {
    std::string error = "Write error: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  // Return the original data length without the header
  return Napi::Number::New(env, bytes_written > 4 ? bytes_written - 4 : 0);
#else
  // On Linux, we write directly from the buffer
  ssize_t bytes_written = write(fd_.get(), data, length);
  if (bytes_written < 0) {
    std::string error = "Write error: ";
    error += strerror(errno);
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  return Napi::Number::New(env, bytes_written);
#endif
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
  if (!info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected function as first argument").ThrowAsJavaScriptException();
    return env.Null();
  }
  StopPolling();

  tsfn_ = Napi::ThreadSafeFunction::New(
    env,
    info[0].As<Napi::Function>(),
    "TunDeviceDataCallback",
    0,
    1
  );

  auto handle = std::make_unique<uv_poll_t>();
  if (uv_poll_init(uv_default_loop(), handle.get(), fd_.get()) != 0) {
      Napi::Error::New(env, "Failed to initialize poll handle").ThrowAsJavaScriptException();
      return env.Null();
  }

  handle->data = this;
  if (uv_poll_start(handle.get(), UV_READABLE, PollCallback) != 0) {
      Napi::Error::New(env, "Failed to start polling").ThrowAsJavaScriptException();
      return env.Null();
  }

  poll_handle_ = handle.release();

  return env.Undefined();
}

void TunDevice::StopPolling() {
  if (poll_handle_) {
    uv_poll_stop(poll_handle_);
    delete poll_handle_;
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
    return;
  }

  if (!(events & UV_READABLE)) {
    return;
  }

  TunDevice* self = static_cast<TunDevice*>(handle->data);
  if (!self || !self->is_open_.load() || !self->fd_.is_valid()) {
    return;
  }

  std::vector<uint8_t> buffer(4096);
  ssize_t bytes_read = read(self->fd_.get(), buffer.data(), buffer.size());

  if (bytes_read <= 0) {
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
        fprintf(stderr, "tuntap read error: %s\n", strerror(errno));
    }
    return;
  }

#ifdef __APPLE__
  if (bytes_read > 4) {
    self->tsfn_.BlockingCall([buffer = std::move(buffer), bytes_read](Napi::Env env, Napi::Function jsCallback) {
      jsCallback.Call({ Napi::Buffer<uint8_t>::Copy(env, buffer.data() + 4, bytes_read - 4) });
    });
  }
#else
  self->tsfn_.BlockingCall([buffer = std::move(buffer), bytes_read](Napi::Env env, Napi::Function jsCallback) {
    jsCallback.Call({ Napi::Buffer<uint8_t>::Copy(env, buffer.data(), bytes_read) });
  });
#endif
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return TunDevice::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)
