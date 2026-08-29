#include <napi.h>

#include <memory>
#include <mutex>
#include <string>
#include <utility>

#include "native/tun_backend.h"
#include "native/tunnel_forwarder.h"

namespace {

class TunDevice : public Napi::ObjectWrap<TunDevice> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit TunDevice(const Napi::CallbackInfo& info);
  ~TunDevice() override;

 private:
  Napi::Value Open(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Read(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value GetName(const Napi::CallbackInfo& info);
  Napi::Value GetFd(const Napi::CallbackInfo& info);
  Napi::Value IsOpen(const Napi::CallbackInfo& info);
  Napi::Value GetForwardingHandle(const Napi::CallbackInfo& info);

  // Both require device_mutex_ to be held by the caller.
  void CloseInternal();
  [[nodiscard]] bool IsOpenLocked() const { return is_open_ && backend_ && backend_->IsOpen(); }

  std::shared_ptr<TunPlatformBackend> backend_;
  std::string requested_name_;
  std::string interface_name_;
  bool is_open_ = false;
  std::mutex device_mutex_;

  // Keep in sync with MAX_BUFFER_SIZE in src/TunTap.ts.
  static constexpr size_t MAX_READ_BUFFER = 65535;
};

Napi::Object TunDevice::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);

  Napi::Function func = DefineClass(env, "TunDevice",
                                    {
                                        InstanceMethod("open", &TunDevice::Open),
                                        InstanceMethod("close", &TunDevice::Close),
                                        InstanceMethod("read", &TunDevice::Read),
                                        InstanceMethod("write", &TunDevice::Write),
                                        InstanceMethod("getName", &TunDevice::GetName),
                                        InstanceMethod("getFd", &TunDevice::GetFd),
                                        InstanceMethod("isOpen", &TunDevice::IsOpen),
                                        InstanceMethod("getForwardingHandle", &TunDevice::GetForwardingHandle),
                                    });

  exports.Set("TunDevice", func);
  return exports;
}

TunDevice::TunDevice(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<TunDevice>(info), backend_(CreatePlatformBackend()) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (info.Length() > 0 && info[0].IsString()) {
    requested_name_ = info[0].As<Napi::String>().Utf8Value();
  }
}

TunDevice::~TunDevice() {
  std::scoped_lock lock(device_mutex_);
  CloseInternal();
}

Napi::Value TunDevice::Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::scoped_lock lock(device_mutex_);

  if (is_open_) {
    return Napi::Boolean::New(env, true);
  }
  if (!backend_) {
    Napi::Error::New(env, "Unsupported platform: no native TUN backend available").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  std::string error;
  std::string assigned_name;
  if (!backend_->OpenDevice(requested_name_, assigned_name, error)) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  interface_name_ = std::move(assigned_name);
  is_open_ = true;
  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::scoped_lock lock(device_mutex_);
  CloseInternal();
  return Napi::Boolean::New(env, true);
}

Napi::Value TunDevice::Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::scoped_lock lock(device_mutex_);

  if (!IsOpenLocked()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t buffer_size = 4096;
  if (info.Length() > 0 && info[0].IsNumber()) {
    buffer_size = info[0].As<Napi::Number>().Uint32Value();
    if (buffer_size == 0 || buffer_size > MAX_READ_BUFFER) {
      Napi::RangeError::New(env, "Read buffer size must be between 1 and " + std::to_string(MAX_READ_BUFFER))
          .ThrowAsJavaScriptException();
      return env.Null();
    }
  }

  std::vector<uint8_t> packet;
  std::string error;
  ReadPacketStatus rs = backend_->ReadPacket(buffer_size, packet, error);
  if (rs == ReadPacketStatus::Error) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (rs == ReadPacketStatus::Closed) {
    CloseInternal();
    Napi::Error::New(env, "TUN device closed").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (rs == ReadPacketStatus::NoData) {
    return {env, Napi::Buffer<uint8_t>::New(env, 0)};
  }
  return {env, Napi::Buffer<uint8_t>::Copy(env, packet.data(), packet.size())};
}

Napi::Value TunDevice::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::scoped_lock lock(device_mutex_);

  if (!IsOpenLocked()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected buffer as first argument").ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }

  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  uint8_t* data = buffer.Data();
  size_t length = buffer.Length();

  std::string error;
  ssize_t bytes_written = backend_->WritePacket(data, length, error);
  if (bytes_written < 0) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }
  return Napi::Number::New(env, static_cast<double>(bytes_written));
}

Napi::Value TunDevice::GetName(const Napi::CallbackInfo& info) {
  std::scoped_lock lock(device_mutex_);
  return Napi::String::New(info.Env(), interface_name_);
}

Napi::Value TunDevice::GetFd(const Napi::CallbackInfo& info) {
  std::scoped_lock lock(device_mutex_);
  return Napi::Number::New(info.Env(), backend_ ? backend_->GetNativeFd() : -1);
}

Napi::Value TunDevice::IsOpen(const Napi::CallbackInfo& info) {
  std::scoped_lock lock(device_mutex_);
  return Napi::Boolean::New(info.Env(), IsOpenLocked());
}

Napi::Value TunDevice::GetForwardingHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::scoped_lock lock(device_mutex_);

  if (!IsOpenLocked()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
  }

  // The External owns a strong ref: the backend stays alive for forwarding
  // threads even if this TunDevice is GC'd first.
  auto* shared = new std::shared_ptr<TunPlatformBackend>(backend_);
  return Napi::External<std::shared_ptr<TunPlatformBackend>>::New(
      env, shared, [](Napi::Env, std::shared_ptr<TunPlatformBackend>* data) { delete data; });
}

void TunDevice::CloseInternal() {
  if (is_open_) {
    is_open_ = false;
    if (backend_) {
      backend_->CloseDevice();
    }
    interface_name_.clear();
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  TunDevice::Init(env, exports);
  InitTunnelForwarder(env, exports);
  return exports;
}

}  // namespace

// __napi_Init, generated below by the macro, keeps 'static' linkage rather than
// an anonymous namespace: it must stay reachable by name for NAPI_MODULE's
// module-registration constructor in the same translation unit.
// NOLINTNEXTLINE(misc-use-anonymous-namespace)
NODE_API_MODULE(tuntap, Init)
