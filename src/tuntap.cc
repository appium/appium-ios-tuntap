#include <napi.h>
#include <unistd.h>
#include <fcntl.h>
#include <string>
#include <string.h>
#include <errno.h>

#ifdef __APPLE__
#include <sys/kern_control.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sys_domain.h>
#include <net/if_utun.h>
#include <netinet/in.h>
#include <netinet6/in6_var.h>
#define UTUN_CONTROL_NAME "com.apple.net.utun_control"
#else
#include <linux/if.h>
#include <linux/if_tun.h>
#endif

class TunDevice : public Napi::ObjectWrap<TunDevice> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  TunDevice(const Napi::CallbackInfo& info);
  ~TunDevice();

private:
  static Napi::FunctionReference constructor;

  Napi::Value Open(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Read(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value GetName(const Napi::CallbackInfo& info);
  Napi::Value GetFd(const Napi::CallbackInfo& info);

  int fd;
  std::string name;
  bool is_open;
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
  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("TunDevice", func);
  return exports;
}

TunDevice::TunDevice(const Napi::CallbackInfo& info)
  : Napi::ObjectWrap<TunDevice>(info), fd(-1), is_open(false) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (info.Length() > 0 && info[0].IsString()) {
    this->name = info[0].As<Napi::String>().Utf8Value();
  }
}

TunDevice::~TunDevice() {
  if (is_open) {
    close(fd);
  }
}

Napi::Value TunDevice::Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (is_open) {
    return Napi::Boolean::New(env, true);
  }

#ifdef __APPLE__
  // macOS implementation using utun interfaces
  struct ctl_info ctlInfo;
  struct sockaddr_ctl sc;

  fd = socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL);
  if (fd < 0) {
    Napi::Error::New(env, "Failed to create control socket").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&ctlInfo, 0, sizeof(ctlInfo));
  strncpy(ctlInfo.ctl_name, UTUN_CONTROL_NAME, sizeof(ctlInfo.ctl_name));

  if (ioctl(fd, CTLIOCGINFO, &ctlInfo) < 0) {
    close(fd);
    fd = -1;
    Napi::Error::New(env, "Failed to get utun control info").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  memset(&sc, 0, sizeof(sc));
  sc.sc_len = sizeof(sc);
  sc.sc_family = AF_SYSTEM;
  sc.ss_sysaddr = SYSPROTO_CONTROL;
  sc.sc_id = ctlInfo.ctl_id;

  // Parse utun number if provided, otherwise use a default (utun0 = unit 1)
  int utun_unit = 0;
  if (!name.empty() && name.find("utun") == 0) {
    try {
      utun_unit = std::stoi(name.substr(4)) + 1; // +1 because kernel uses unit=1 for utun0
    } catch(...) {
      utun_unit = 0;
    }
  }

  if (utun_unit > 0) {
    sc.sc_unit = utun_unit;
  // Try to connect with the specified unit
   if (connect(fd, (struct sockaddr*)&sc, sizeof(sc)) < 0) {
    close(fd);
     fd = -1;
    Napi::Error::New(env, "Failed to connect to utun control socket with specified unit").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
   }
  } else {
    // Find the first available unit
    for (sc.sc_unit = 1; sc.sc_unit < 255; sc.sc_unit++) {
      if (connect(fd, (struct sockaddr*)&sc, sizeof(sc)) == 0) {
        break;
     } else if (errno != EBUSY) {
        close(fd);
        fd = -1;
        Napi::Error::New(env, "Failed to connect to utun control socket").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
      }
    }

    if (sc.sc_unit >= 255) {
      close(fd);
      fd = -1;
      Napi::Error::New(env, "Could not find an available utun device").ThrowAsJavaScriptException();
      return Napi::Boolean::New(env, false);
    }
  }

  // Get the utun device name
  char utunname[20];
  socklen_t utunname_len = sizeof(utunname);
  if (getsockopt(fd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, utunname, &utunname_len) < 0) {
    close(fd);
    fd = -1;
    Napi::Error::New(env, "Failed to get utun interface name").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name = std::string(utunname);

#else
  // Linux implementation using TUN/TAP
  fd = open("/dev/net/tun", O_RDWR);
  if (fd < 0) {
    Napi::Error::New(env, "Failed to open /dev/net/tun").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));

  // Set flags - IFF_TUN for TUN device, IFF_NO_PI to not provide packet info
  ifr.ifr_flags = IFF_TUN | IFF_NO_PI;

  // If name is provided, use it
  if (!name.empty()) {
    strncpy(ifr.ifr_name, name.c_str(), IFNAMSIZ);
  }

  if (ioctl(fd, TUNSETIFF, &ifr) < 0) {
    close(fd);
    fd = -1;
    Napi::Error::New(env, "Failed to configure TUN device").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  name = std::string(ifr.ifr_name);
#endif

  // Set non-blocking mode
  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  is_open = true;
  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (is_open) {
    close(fd);
    fd = -1;
    is_open = false;
  }

  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!is_open) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
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
  uint8_t tmp_buffer[buffer_size + 4];

  ssize_t bytes_read = read(fd, tmp_buffer, buffer_size + 4);
  if (bytes_read <= 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // No data available
      return Napi::Buffer<uint8_t>::New(env, 0);
    }

    // Error occurred
    return Napi::Error::New(env, strerror(errno)).Value();
  }

  // Skip the 4-byte protocol family header
  if (bytes_read > 4) {
    memcpy(data, tmp_buffer + 4, bytes_read - 4);
    return Napi::Buffer<uint8_t>::Copy(env, data, bytes_read - 4);
  } else {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
#else
  // On Linux, we read directly into the buffer
  ssize_t bytes_read = read(fd, data, buffer_size);
  if (bytes_read < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      // No data available
      return Napi::Buffer<uint8_t>::New(env, 0);
    }

    // Error occurred
    return Napi::Error::New(env, strerror(errno)).Value();
  }

  return Napi::Buffer<uint8_t>::Copy(env, data, bytes_read);
#endif
}

Napi::Value TunDevice::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!is_open) {
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
  // On macOS, we need to prepend a 4-byte protocol family header
  // For IPv6, the protocol family is AF_INET6 (30 on macOS)
  uint8_t tmp_buffer[length + 4];
  uint32_t family = htonl(AF_INET6);

  memcpy(tmp_buffer, &family, 4);
  memcpy(tmp_buffer + 4, data, length);

  ssize_t bytes_written = write(fd, tmp_buffer, length + 4);
  if (bytes_written < 0) {
    return Napi::Error::New(env, strerror(errno)).Value();
  }

  // Return the original data length without the header
  return Napi::Number::New(env, bytes_written > 4 ? bytes_written - 4 : 0);
#else
  // On Linux, we write directly from the buffer
  ssize_t bytes_written = write(fd, data, length);
  if (bytes_written < 0) {
    return Napi::Error::New(env, strerror(errno)).Value();
  }

  return Napi::Number::New(env, bytes_written);
#endif
}

Napi::Value TunDevice::GetName(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), name);
}

Napi::Value TunDevice::GetFd(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), fd);
}

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return TunDevice::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)