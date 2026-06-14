#include <napi.h>

#include <atomic>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <deque>

#include "native/tun_backend.h"

#if defined(__APPLE__) || defined(__linux__)
#include "native/tunnel_bridge.h"
#endif

struct TunPollDispatch {
  Napi::ThreadSafeFunction tsfn;
  std::mutex mutex;
  std::deque<std::vector<uint8_t>> pending;
  size_t max_pending_ = 1;
  class TunDevice* device_ = nullptr;

  struct PacketJob {
    TunPollDispatch* dispatch;
    std::vector<uint8_t>* packet;
  };

  void OnJsConsumed();

  static void CallJs(Napi::Env env,
                     Napi::Function jsCallback,
                     TunPollDispatch* self,
                     std::vector<uint8_t>* packet) {
    if (env == nullptr || jsCallback.IsEmpty() || packet == nullptr) {
      delete packet;
      return;
    }
    auto* backing = packet;
    Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(
        env,
        backing->data(),
        backing->size(),
        [](Napi::Env, uint8_t*, std::vector<uint8_t>* vec) { delete vec; },
        backing);
    jsCallback.Call({buf});
    if (self != nullptr) {
      self->OnJsConsumed();
    }
  }

  void FlushPending() {
    std::lock_guard<std::mutex> lock(mutex);
    while (!pending.empty()) {
      auto* packet = new std::vector<uint8_t>(std::move(pending.front()));
      auto* job = new PacketJob{this, packet};
      napi_status status = tsfn.NonBlockingCall(
          job,
          [](Napi::Env env, Napi::Function jsCallback, PacketJob* job) {
            CallJs(env, jsCallback, job->dispatch, job->packet);
            delete job;
          });
      if (status != napi_ok) {
        delete packet;
        delete job;
        break;
      }
      pending.pop_front();
    }
  }

  bool PostPacket(std::vector<uint8_t> packet) {
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (pending.size() >= max_pending_) {
        return false;
      }
      pending.push_back(std::move(packet));
    }
    FlushPending();
    std::lock_guard<std::mutex> lock(mutex);
    return pending.size() < max_pending_;
  }
};

class TunDevice : public Napi::ObjectWrap<TunDevice> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  TunDevice(const Napi::CallbackInfo& info);
  ~TunDevice();

  void CloseInternal();
  void ResumeReceiveFromDispatch();

private:
  friend struct TunPollDispatch;
  static Napi::FunctionReference constructor;

  Napi::Value Open(const Napi::CallbackInfo& info);
  Napi::Value Close(const Napi::CallbackInfo& info);
  Napi::Value Read(const Napi::CallbackInfo& info);
  Napi::Value Write(const Napi::CallbackInfo& info);
  Napi::Value GetName(const Napi::CallbackInfo& info);
  Napi::Value GetFd(const Napi::CallbackInfo& info);
  Napi::Value StartPolling(const Napi::CallbackInfo& info);
  Napi::Value PausePolling(const Napi::CallbackInfo& info);
  Napi::Value ResumePolling(const Napi::CallbackInfo& info);

  std::unique_ptr<TunPlatformBackend> backend_;
  std::string requested_name_;
  std::string interface_name_;
  std::atomic<bool> is_open_;
  std::mutex device_mutex_;

  Napi::ThreadSafeFunction tsfn_;
  TunPollDispatch* poll_dispatch_ = nullptr;
  std::atomic<bool> polling_;
  static constexpr size_t MAX_POLL_BUFFER = 65535;

  void StopPollingLocked();
  void ReleaseTsfnLocked();
  void PauseReceiveFromDispatch();
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
    InstanceMethod("pausePolling", &TunDevice::PausePolling),
    InstanceMethod("resumePolling", &TunDevice::ResumePolling),
  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("TunDevice", func);
  return exports;
}

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

Napi::Value TunDevice::Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);
  CloseInternal();
  return Napi::Boolean::New(env, true);
}

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

Napi::Value TunDevice::GetName(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::String::New(info.Env(), interface_name_);
}

Napi::Value TunDevice::GetFd(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(device_mutex_);
  return Napi::Number::New(info.Env(), backend_ ? backend_->GetNativeFd() : -1);
}

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

  size_t queue_depth = 8;
  if (info.Length() > 2 && info[2].IsNumber()) {
    queue_depth = info[2].As<Napi::Number>().Uint32Value();
    if (queue_depth == 0 || queue_depth > 64) {
      Napi::RangeError::New(env, "Queue depth must be between 1 and 64").ThrowAsJavaScriptException();
      return env.Null();
    }
  }

  // Queue depth > 1 lets the poll thread post the next packet while JS is still
  // handling the previous callback (still serialized on the main thread).
  tsfn_ = Napi::ThreadSafeFunction::New(
      env,
      info[0].As<Napi::Function>(),
      "TunDeviceDataCallback",
      0,
      queue_depth);

  uv_loop_t* loop = nullptr;
  napi_status napi_st = napi_get_uv_event_loop(env, &loop);
  if (napi_st != napi_ok || loop == nullptr) {
    ReleaseTsfnLocked();
    Napi::Error::New(env, "Failed to acquire event loop").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::ThreadSafeFunction tsfn = tsfn_;
  auto* dispatch = new TunPollDispatch();
  dispatch->tsfn = tsfn;
  dispatch->max_pending_ = queue_depth;
  dispatch->device_ = this;
  poll_dispatch_ = dispatch;
  auto packet_cb = [this, dispatch](std::vector<uint8_t> packet) mutable -> bool {
    const bool accepted = dispatch->PostPacket(std::move(packet));
    if (polling_ && backend_) {
      // Pause until the JS callback runs (pmd3 reads one utun packet per iteration).
      backend_->PauseReceiveLoop();
    }
    return accepted;
  };
  // Terminal errors from the receive loop (poll error, device closed, read
  // error) call back here so the JS-side polling_ flag and TSFN are released
  // promptly. Callback runs on the libuv thread, which only fires between JS
  // ticks, so acquiring `device_mutex_` is safe.
  auto error_cb = [this](const std::string& message) {
    fprintf(stderr, "tuntap receive loop error: %s\n", message.c_str());
    std::lock_guard<std::mutex> lock(device_mutex_);
    polling_ = false;
    ReleaseTsfnLocked();
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

Napi::Value TunDevice::PausePolling(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!polling_ || !backend_ || !backend_->IsOpen()) {
    return env.Undefined();
  }

  backend_->PauseReceiveLoop();
  return env.Undefined();
}

Napi::Value TunDevice::ResumePolling(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(device_mutex_);

  if (!polling_ || !backend_ || !backend_->IsOpen()) {
    return env.Undefined();
  }

  backend_->ResumeReceiveLoop();
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  TunDevice::Init(env, exports);
#if defined(__APPLE__) || defined(__linux__)
  InitTunnelBridge(env, exports);
#endif
  return exports;
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
  // Release TSFN first — it blocks until queued callbacks finish. Those callbacks
  // may still dereference poll_dispatch_, so it must outlive the TSFN drain.
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
  if (poll_dispatch_ != nullptr) {
    delete poll_dispatch_;
    poll_dispatch_ = nullptr;
  }
}

void TunPollDispatch::OnJsConsumed() {
  FlushPending();
  TunDevice* device = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex);
    if (pending.empty() && device_ != nullptr) {
      device = device_;
    }
  }
  if (device != nullptr) {
    device->ResumeReceiveFromDispatch();
  }
}

void TunDevice::PauseReceiveFromDispatch() {
  std::lock_guard<std::mutex> lock(device_mutex_);
  if (polling_ && backend_) {
    backend_->PauseReceiveLoop();
  }
}

void TunDevice::ResumeReceiveFromDispatch() {
  std::lock_guard<std::mutex> lock(device_mutex_);
  if (polling_ && backend_) {
    backend_->ResumeReceiveLoop();
  }
}
