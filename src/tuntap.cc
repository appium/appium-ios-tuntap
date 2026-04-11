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
#include <uv.h>

#ifdef __APPLE__
#include <sys/kern_control.h>
#include <sys/socket.h>
#include <sys/sys_domain.h>
#include <net/if_utun.h>
#include <netinet/in.h>
#include <netinet6/in6_var.h>
#define UTUN_CONTROL_NAME "com.apple.net.utun_control"
#define UTUN_HEADER_SIZE 4
#else
#include <linux/if.h>
#include <linux/if_tun.h>
#include <sys/stat.h>
#define UTUN_HEADER_SIZE 0
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

#ifdef __APPLE__
  // macOS: create utun interface via PF_SYSTEM control socket
  struct ctl_info ctlInfo;
  struct sockaddr_ctl sc;

  FileDescriptor temp_fd(socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL));
  if (!temp_fd.is_valid()) {
    Napi::Error::New(env, std::string("Failed to create control socket: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&ctlInfo, 0, sizeof(ctlInfo));
  strncpy(ctlInfo.ctl_name, UTUN_CONTROL_NAME, sizeof(ctlInfo.ctl_name) - 1);
  ctlInfo.ctl_name[sizeof(ctlInfo.ctl_name) - 1] = '\0';

  if (ioctl(temp_fd.get(), CTLIOCGINFO, &ctlInfo) < 0) {
    Napi::Error::New(env, std::string("Failed to get utun control info: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&sc, 0, sizeof(sc));
  sc.sc_len = sizeof(sc);
  sc.sc_family = AF_SYSTEM;
  sc.ss_sysaddr = SYSPROTO_CONTROL;
  sc.sc_id = ctlInfo.ctl_id;

  // Parse utun number if provided, otherwise auto-select (utun0 = unit 1)
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
    if (connect(temp_fd.get(), (struct sockaddr*)&sc, sizeof(sc)) < 0) {
      Napi::Error::New(env, std::string("Failed to connect to utun with specified unit: ") + strerror(errno))
        .ThrowAsJavaScriptException();
      return Napi::Boolean::New(env, false);
    }
  } else {
    bool connected = false;
    for (sc.sc_unit = 1; sc.sc_unit < 255; sc.sc_unit++) {
      if (connect(temp_fd.get(), (struct sockaddr*)&sc, sizeof(sc)) == 0) {
        connected = true;
        break;
      } else if (errno != EBUSY) {
        Napi::Error::New(env, std::string("Failed to connect to utun control socket: ") + strerror(errno))
          .ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
      }
    }

    if (!connected) {
      Napi::Error::New(env, "Could not find an available utun device").ThrowAsJavaScriptException();
      return Napi::Boolean::New(env, false);
    }
  }

  char utunname[20];
  socklen_t utunname_len = sizeof(utunname);
  if (getsockopt(temp_fd.get(), SYSPROTO_CONTROL, UTUN_OPT_IFNAME, utunname, &utunname_len) < 0) {
    Napi::Error::New(env, std::string("Failed to get utun interface name: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name_ = std::string(utunname);

#else
  // Linux: create TUN device via /dev/net/tun
  struct stat statbuf;
  if (stat("/dev/net/tun", &statbuf) != 0) {
    Napi::Error::New(env,
      "TUN/TAP device not available: /dev/net/tun does not exist. "
      "Please ensure the TUN/TAP kernel module is loaded (modprobe tun).")
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  FileDescriptor temp_fd(open("/dev/net/tun", O_RDWR));
  if (!temp_fd.is_valid()) {
    Napi::Error::New(env,
      std::string("Failed to open /dev/net/tun: ") + strerror(errno) +
      ". This usually means you don't have sufficient permissions. "
      "Try running with sudo or add your user to the 'tun' group.")
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  ifr.ifr_flags = IFF_TUN | IFF_NO_PI;

  if (!name_.empty()) {
    strncpy(ifr.ifr_name, name_.c_str(), IFNAMSIZ - 1);
    ifr.ifr_name[IFNAMSIZ - 1] = '\0';
  }

  if (ioctl(temp_fd.get(), TUNSETIFF, &ifr) < 0) {
    Napi::Error::New(env, std::string("Failed to configure TUN device: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name_ = std::string(ifr.ifr_name);
#endif

  // Set non-blocking mode
  int flags = fcntl(temp_fd.get(), F_GETFL, 0);
  if (flags < 0) {
    Napi::Error::New(env, std::string("Failed to get file descriptor flags: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  if (fcntl(temp_fd.get(), F_SETFL, flags | O_NONBLOCK) < 0) {
    Napi::Error::New(env, std::string("Failed to set non-blocking mode: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

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

  size_t buffer_size = 4096;
  if (info.Length() > 0 && info[0].IsNumber()) {
    buffer_size = info[0].As<Napi::Number>().Uint32Value();
    if (buffer_size == 0 || buffer_size > MAX_POLL_BUFFER) {
      Napi::RangeError::New(env, "Read buffer size must be between 1 and 65535").ThrowAsJavaScriptException();
      return env.Null();
    }
  }

#ifdef __APPLE__
  // macOS: reads include a 4-byte protocol family prefix that must be stripped
  std::vector<uint8_t> raw(buffer_size + 4);
  ssize_t n = read(fd_.get(), raw.data(), raw.size());
  if (n <= 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return Napi::Buffer<uint8_t>::New(env, 0);
    }
    Napi::Error::New(env, std::string("Read error: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (n <= 4) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  return Napi::Buffer<uint8_t>::Copy(env, raw.data() + 4, n - 4);
#else
  // Linux: raw IP packets directly
  std::vector<uint8_t> raw(buffer_size);
  ssize_t n = read(fd_.get(), raw.data(), raw.size());
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return Napi::Buffer<uint8_t>::New(env, 0);
    }
    Napi::Error::New(env, std::string("Read error: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Buffer<uint8_t>::Copy(env, raw.data(), n);
#endif
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

#ifdef __APPLE__
  // macOS: prepend 4-byte AF_INET6 protocol family header
  std::vector<uint8_t> frame(length + 4);
  uint32_t family = htonl(AF_INET6);
  memcpy(frame.data(), &family, 4);
  memcpy(frame.data() + 4, data, length);

  ssize_t bytes_written = write(fd_.get(), frame.data(), frame.size());
  if (bytes_written < 0) {
    Napi::Error::New(env, std::string("Write error: ") + strerror(errno))
      .ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }
  return Napi::Number::New(env, bytes_written > 4 ? bytes_written - 4 : 0);
#else
  ssize_t bytes_written = write(fd_.get(), data, length);
  if (bytes_written < 0) {
    Napi::Error::New(env, std::string("Write error: ") + strerror(errno))
      .ThrowAsJavaScriptException();
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
      Napi::RangeError::New(env, "Buffer size must be between 1 and 65535").ThrowAsJavaScriptException();
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

  std::vector<uint8_t> buffer(self->poll_buffer_size_ + UTUN_HEADER_SIZE);
  ssize_t bytes_read = read(self->fd_.get(), buffer.data(), buffer.size());

  if (bytes_read == 0) {
    self->StopPolling();
    return;
  }
  if (bytes_read < 0) {
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      fprintf(stderr, "tuntap read error: %s\n", strerror(errno));
      self->StopPolling();
    }
    return;
  }

  if (bytes_read > UTUN_HEADER_SIZE) {
    self->tsfn_.BlockingCall(
      [buf = std::move(buffer), bytes_read](Napi::Env env, Napi::Function jsCallback) {
        if (env == nullptr || jsCallback.IsEmpty()) return;
        jsCallback.Call({ Napi::Buffer<uint8_t>::Copy(env, buf.data() + UTUN_HEADER_SIZE, bytes_read - UTUN_HEADER_SIZE) });
      }
    );
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return TunDevice::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)
