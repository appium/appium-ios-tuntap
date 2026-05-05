#include <napi.h>

#include <atomic>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "native/tun_backend.h"

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

  std::unique_ptr<TunPlatformBackend> backend_;
  std::string requested_name_;
  std::string interface_name_;
  std::atomic<bool> is_open_;
  std::mutex device_mutex_;

  Napi::ThreadSafeFunction tsfn_;
  std::atomic<bool> polling_;
  static constexpr size_t MAX_POLL_BUFFER = 65535;

  void StopPollingLocked();
  void ReleaseTsfnLocked();
};

Napi::FunctionReference TunDevice::constructor;

// Defines and exports the JS class constructor: new TunDevice(name?)
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

// Creates a TunDevice wrapper; optional first arg is requested interface name.
TunDevice::TunDevice(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<TunDevice>(info),
      backend_(CreatePlatformBackend()),
      is_open_(false),
      polling_(false) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);

  if (info.Length() > 0 && info[0].IsString()) {
    requested_name_ = info[0].As<Napi::String>().Utf8Value();
  }
}

// Ensures backend resources and polling are released when object is destroyed.
TunDevice::~TunDevice() {
  std::lock_guard<std::mutex> lock(device_mutex_);
  CloseInternal();
}

// JS: open() -> boolean
// Opens the backend device.
Napi::Value TunDevice::Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (is_open_) {
    return Napi::Boolean::New(env, true);
  }
  if (!backend_) {
    Napi::Error::New(env, "Unsupported platform: no native TUN backend available")
      .ThrowAsJavaScriptException();
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

// JS: close() -> boolean
// Safely closes device resources; calling multiple times is allowed.
Napi::Value TunDevice::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);
  CloseInternal();
  return Napi::Boolean::New(env, true);
}

// JS: read(bufferSize?) -> Buffer
// Reads one payload packet, or returns an empty Buffer when no data is available.
Napi::Value TunDevice::Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !backend_ || !backend_->IsOpen()) {
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
  ReadPacketStatus rs = backend_->ReadPacket(buffer_size, packet, error);
  if (rs == ReadPacketStatus::Error) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Null();
  }
  if (rs == ReadPacketStatus::NoData || rs == ReadPacketStatus::Closed) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  return Napi::Buffer<uint8_t>::Copy(env, packet.data(), packet.size());
}

// JS: write(buffer) -> number
// Writes one packet and returns payload bytes accepted by the backend.
Napi::Value TunDevice::Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !backend_ || !backend_->IsOpen()) {
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
  ssize_t bytes_written = backend_->WritePacket(data, length, error);
  if (bytes_written < 0) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return Napi::Number::New(env, -1);
  }
  return Napi::Number::New(env, static_cast<double>(bytes_written));
}

// JS: getName() -> string
// Returns the assigned interface name after open().
Napi::Value TunDevice::GetName(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::String::New(info.Env(), interface_name_);
}

// JS: getFd() -> number
// Returns the native file descriptor when one exists, or -1 otherwise
// (e.g. before open(), after close(), or on backends without a numeric fd).
Napi::Value TunDevice::GetFd(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::Number::New(info.Env(), backend_ ? backend_->GetNativeFd() : -1);
}

// JS: startPolling(callback, bufferSize?) -> void
// Starts asynchronous packet delivery; the backend invokes `callback` per packet.
Napi::Value TunDevice::StartPolling(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!is_open_ || !backend_ || !backend_->IsOpen()) {
    Napi::Error::New(env, "Device not open").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected function as first argument").ThrowAsJavaScriptException();
    return env.Null();
  }

  StopPollingLocked();

  size_t buffer_size = MAX_POLL_BUFFER;
  if (info.Length() > 1 && info[1].IsNumber()) {
    auto size = info[1].As<Napi::Number>().Uint32Value();
    if (size == 0 || size > MAX_POLL_BUFFER) {
      Napi::RangeError::New(env, "Buffer size must be between 1 and " + std::to_string(MAX_POLL_BUFFER)).ThrowAsJavaScriptException();
      return env.Null();
    }
    buffer_size = size;
  }

  tsfn_ = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "TunDeviceDataCallback",
      0,
      1);

  uv_loop_t* loop = nullptr;
  napi_status napi_st = napi_get_uv_event_loop(env, &loop);
  if (napi_st != napi_ok || loop == nullptr) {
    ReleaseTsfnLocked();
    Napi::Error::New(env, "Failed to acquire event loop").ThrowAsJavaScriptException();
    return env.Null();
  }

  // The TSFN handle is captured by value into both callbacks; backend lifetime
  // outlives both because we own it and `StopReceiveLoop` runs synchronously
  // on close.
  Napi::ThreadSafeFunction tsfn = tsfn_;
  auto packet_cb = [tsfn](std::vector<uint8_t> packet) mutable {
    tsfn.BlockingCall(
        [packet = std::move(packet)](Napi::Env env, Napi::Function jsCallback) {
          if (env == nullptr || jsCallback.IsEmpty()) {
            return;
          }
          jsCallback.Call({Napi::Buffer<uint8_t>::Copy(env, packet.data(), packet.size())});
        });
  };
  auto error_cb = [](const std::string& message) {
    fprintf(stderr, "tuntap receive loop error: %s\n", message.c_str());
  };

  std::string start_error;
  if (!backend_->StartReceiveLoop(loop, buffer_size, std::move(packet_cb), std::move(error_cb), start_error)) {
    ReleaseTsfnLocked();
    Napi::Error::New(env, start_error).ThrowAsJavaScriptException();
    return env.Null();
  }

  polling_ = true;
  return env.Undefined();
}

// Node-API module entrypoint.
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return TunDevice::Init(env, exports);
}

NODE_API_MODULE(tuntap, Init)

void TunDevice::CloseInternal() {
  if (is_open_.exchange(false)) {
    StopPollingLocked();
    if (backend_) {
      backend_->CloseDevice();
    }
    interface_name_.clear();
  }
}

void TunDevice::StopPollingLocked() {
  if (polling_.exchange(false) && backend_) {
    backend_->StopReceiveLoop();
  }
  ReleaseTsfnLocked();
}

void TunDevice::ReleaseTsfnLocked() {
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
}
