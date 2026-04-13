#include <napi.h>
#include <uv.h>

#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <atomic>
#include <cstdio>

#include "native/file_descriptor.h"
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
