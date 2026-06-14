#if defined(__APPLE__) || defined(__linux__)

#include "tunnel_bridge.h"

#include <cerrno>
#include <cstring>
#include <unistd.h>

#ifdef __APPLE__
#include <arpa/inet.h>
#endif

#include "ipv6_frame.h"
#include "debug_log.h"

struct TunnelBridge::State {
  TunnelBridge* bridge = nullptr;
};

namespace {

#ifdef __APPLE__
constexpr size_t kUtunHeaderSize = 4;
#endif

/** Max utun packets buffered before pausing TUN poll (matches former TunToDevicePump). */
constexpr size_t kMaxTunEgressQueue = 256;
/** Max TLS ingress bytes before declaring framing failure. */
constexpr size_t kMaxIngressBuffer = 256 * 1024;

}  // namespace

TunnelBridge::TunnelBridge() = default;

TunnelBridge::~TunnelBridge() {
  Stop();
}

bool TunnelBridge::Start(Napi::Env env,
                         int tun_fd,
                         size_t mtu,
                         Napi::Function on_socket_write,
                         Napi::Function on_error,
                         std::string& error) {
  if (running_.load()) {
    error = "Tunnel bridge already started";
    return false;
  }
  if (tun_fd < 0) {
    error = "Invalid TUN file descriptor";
    return false;
  }
  if (mtu == 0 || mtu > 65535) {
    error = "Invalid MTU";
    return false;
  }

  tun_fd_ = tun_fd;
  mtu_ = mtu;
  socket_blocked_.store(false);
  tun_write_blocked_.store(false);
  tun_poll_paused_.store(false);

  on_socket_write_ = Napi::Persistent(on_socket_write);
  on_error_ = Napi::Persistent(on_error);

  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == nullptr) {
    error = "Failed to acquire event loop";
    on_socket_write_.Reset();
    on_error_.Reset();
    return false;
  }

  state_ = new State();
  state_->bridge = this;
  tun_poll_.data = state_;

  if (uv_poll_init(loop, &tun_poll_, tun_fd_) != 0) {
    error = "Failed to initialize TUN poll handle";
    delete state_;
    state_ = nullptr;
    on_socket_write_.Reset();
    on_error_.Reset();
    return false;
  }
  poll_inited_ = true;

  if (uv_poll_start(&tun_poll_, UV_READABLE, &TunnelBridge::OnTunPoll) != 0) {
    error = "Failed to start TUN poll";
    uv_close(reinterpret_cast<uv_handle_t*>(&tun_poll_), nullptr);
    poll_inited_ = false;
    delete state_;
    state_ = nullptr;
    on_socket_write_.Reset();
    on_error_.Reset();
    return false;
  }

  running_.store(true);
  tuntap::FwdDebug("bridge-native-start", "mtu=%zu tunFd=%d", mtu_, tun_fd_);
  return true;
}

void TunnelBridge::Stop() {
  if (!running_.exchange(false)) {
    return;
  }

  tuntap::FwdDebug("bridge-native-stop");

  socket_blocked_.store(false);
  tun_write_blocked_.store(false);
  tun_poll_paused_.store(false);

  on_socket_write_.Reset();
  on_error_.Reset();

  {
    std::lock_guard<std::mutex> lock(mutex_);
    socket_ingress_.clear();
    tun_egress_.clear();
    tun_fd_ = -1;
  }

  if (poll_inited_) {
    uv_poll_stop(&tun_poll_);
    poll_inited_ = false;
    uv_close(reinterpret_cast<uv_handle_t*>(&tun_poll_), &TunnelBridge::OnPollClose);
    state_ = nullptr;
    return;
  }

  delete state_;
  state_ = nullptr;
}

void TunnelBridge::FeedSocket(const uint8_t* data, size_t len) {
  if (!running_.load() || len == 0) {
    return;
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (socket_ingress_.size() + len > kMaxIngressBuffer) {
      EmitError("Socket ingress buffer overflow");
      running_.store(false);
      return;
    }
    socket_ingress_.insert(socket_ingress_.end(), data, data + len);
  }
  ProcessSocketIngress();
}

void TunnelBridge::NotifySocketDrain() {
  if (!running_.load()) {
    return;
  }
  socket_blocked_.store(false);
  FlushTunEgress();
  ResumeTunPoll();
  ProcessSocketIngress();
  ProcessTunReadable();
}

void TunnelBridge::PauseTunPoll() {
  if (!poll_inited_ || !running_.load() || tun_poll_paused_.load()) {
    return;
  }
  tun_poll_paused_.store(true);
  uv_poll_stop(&tun_poll_);
}

void TunnelBridge::ResumeTunPoll() {
  if (!poll_inited_ || !running_.load() || !tun_poll_paused_.load()) {
    return;
  }
  tun_poll_paused_.store(false);
  UpdateTunPollInterest();
}

void TunnelBridge::UpdateTunPollInterest() {
  if (!poll_inited_ || !running_.load() || tun_poll_paused_.load()) {
    return;
  }
  int events = UV_READABLE;
  if (tun_write_blocked_.load()) {
    events |= UV_WRITABLE;
  }
  uv_poll_stop(&tun_poll_);
  uv_poll_start(&tun_poll_, events, &TunnelBridge::OnTunPoll);
}

bool TunnelBridge::ReadTunPacket(std::vector<uint8_t>& out) {
#ifdef __APPLE__
  uint8_t frame[4 + 65535];
  const size_t cap = 4 + mtu_;
#else
  uint8_t frame[65535];
  const size_t cap = mtu_;
#endif
  const ssize_t n = read(tun_fd_, frame, cap);
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      return false;
    }
    EmitError(std::string("TUN read error: ") + strerror(errno));
    running_.store(false);
    return false;
  }
  if (n == 0) {
    EmitError("TUN device closed");
    running_.store(false);
    return false;
  }
#ifdef __APPLE__
  if (n <= static_cast<ssize_t>(kUtunHeaderSize)) {
    return false;
  }
  out.assign(frame + kUtunHeaderSize, frame + n);
#else
  out.assign(frame, frame + n);
#endif
  return true;
}

ssize_t TunnelBridge::WriteTunPacket(const uint8_t* data, size_t len) {
#ifdef __APPLE__
  std::vector<uint8_t> frame(len + kUtunHeaderSize);
  const uint32_t family = htonl(AF_INET6);
  std::memcpy(frame.data(), &family, kUtunHeaderSize);
  std::memcpy(frame.data() + kUtunHeaderSize, data, len);
  size_t offset = 0;
  while (offset < frame.size()) {
    const ssize_t n = write(tun_fd_, frame.data() + offset, frame.size() - offset);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return 0;
      }
      EmitError(std::string("TUN write error: ") + strerror(errno));
      running_.store(false);
      return -1;
    }
    if (n == 0) {
      EmitError("TUN write returned zero");
      running_.store(false);
      return -1;
    }
    offset += static_cast<size_t>(n);
  }
  return static_cast<ssize_t>(len);
#else
  size_t offset = 0;
  while (offset < len) {
    const ssize_t n = write(tun_fd_, data + offset, len - offset);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return 0;
      }
      EmitError(std::string("TUN write error: ") + strerror(errno));
      running_.store(false);
      return -1;
    }
    if (n == 0) {
      EmitError("TUN write returned zero");
      running_.store(false);
      return -1;
    }
    offset += static_cast<size_t>(n);
  }
  return static_cast<ssize_t>(len);
#endif
}

void TunnelBridge::ProcessSocketIngress() {
  if (!running_.load()) {
    return;
  }

  std::vector<std::vector<uint8_t>> frames;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    ipv6_frame::DrainFrames(socket_ingress_, frames);
  }

  for (size_t i = 0; i < frames.size(); ++i) {
    const ssize_t written = WriteTunPacket(frames[i].data(), frames[i].size());
    if (written < 0) {
      return;
    }
    if (written == static_cast<ssize_t>(frames[i].size())) {
      continue;
    }

    // utun write blocked — put this frame and any remaining back for retry
    std::vector<uint8_t> remainder;
    for (size_t j = i; j < frames.size(); ++j) {
      remainder.insert(remainder.end(), frames[j].begin(), frames[j].end());
    }
    if (!remainder.empty()) {
      std::lock_guard<std::mutex> lock(mutex_);
      socket_ingress_.insert(socket_ingress_.begin(), remainder.begin(), remainder.end());
    }
    tun_write_blocked_.store(true);
    tuntap::FwdDebug("bridge-tun-write-blocked", "ingress=%zu", socket_ingress_.size());
    UpdateTunPollInterest();
    return;
  }
  tun_write_blocked_.store(false);
  UpdateTunPollInterest();
}

bool TunnelBridge::WritePacketToSocket(const std::vector<uint8_t>& packet) {
  if (!on_socket_write_) {
    return false;
  }

  Napi::Env env = on_socket_write_.Env();
  Napi::HandleScope scope(env);
  Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, packet.data(), packet.size());
  Napi::Value result = on_socket_write_.Call({buf});
  if (!result.IsBoolean()) {
    return true;
  }
  return result.As<Napi::Boolean>().Value();
}

void TunnelBridge::FlushTunEgress() {
  while (running_.load() && !tun_egress_.empty()) {
    if (!WritePacketToSocket(tun_egress_.front())) {
      socket_blocked_.store(true);
      tuntap::FwdDebug("bridge-socket-blocked", "queued=%zu", tun_egress_.size());
      return;
    }
    tun_egress_.erase(tun_egress_.begin());
    ProcessSocketIngress();
  }
  MaybePauseTunPollForEgress();
}

void TunnelBridge::MaybePauseTunPollForEgress() {
  if (tun_egress_.size() >= kMaxTunEgressQueue) {
    tuntap::FwdDebug("bridge-egress-pause", "queued=%zu", tun_egress_.size());
    PauseTunPoll();
  } else {
    ResumeTunPoll();
  }
}

void TunnelBridge::ProcessTunReadable() {
  if (!running_.load()) {
    return;
  }

  while (running_.load()) {
    if (!socket_blocked_.load()) {
      FlushTunEgress();
      if (socket_blocked_.load()) {
        break;
      }
    }

    if (tun_egress_.size() >= kMaxTunEgressQueue) {
      break;
    }

    std::vector<uint8_t> packet;
    if (!ReadTunPacket(packet) || packet.empty()) {
      break;
    }

    if (!socket_blocked_.load()) {
      if (!WritePacketToSocket(packet)) {
        socket_blocked_.store(true);
        tuntap::FwdDebug("bridge-socket-blocked", "queued=%zu", tun_egress_.size());
        tun_egress_.push_back(std::move(packet));
      }
    } else {
      tun_egress_.push_back(std::move(packet));
    }
  }

  MaybePauseTunPollForEgress();
  ProcessSocketIngress();
}

void TunnelBridge::EmitError(const std::string& message) {
  if (!on_error_) {
    return;
  }
  Napi::Env env = on_error_.Env();
  Napi::HandleScope scope(env);
  on_error_.Call({Napi::String::New(env, message)});
}

void TunnelBridge::OnPollClose(uv_handle_t* handle) {
  delete static_cast<State*>(handle->data);
}

void TunnelBridge::OnTunPoll(uv_poll_t* handle, int status, int events) {
  auto* state = static_cast<State*>(handle->data);
  if (state == nullptr || state->bridge == nullptr) {
    return;
  }

  TunnelBridge* bridge = state->bridge;
  if (!bridge->running_.load()) {
    return;
  }

  if (status < 0) {
    bridge->EmitError(std::string("TUN poll error: ") + uv_strerror(status));
    bridge->running_.store(false);
    return;
  }

  if (events & UV_WRITABLE) {
    bridge->ProcessSocketIngress();
  }

  if (events & UV_READABLE) {
    bridge->ProcessSocketIngress();
    bridge->ProcessTunReadable();
  }
}

// --- N-API wrapper ---

class TunnelBridgeWrap : public Napi::ObjectWrap<TunnelBridgeWrap> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env,
                    "TunnelBridge",
                    {InstanceMethod("start", &TunnelBridgeWrap::Start),
                     InstanceMethod("stop", &TunnelBridgeWrap::Stop),
                     InstanceMethod("feedSocket", &TunnelBridgeWrap::FeedSocket),
                     InstanceMethod("notifySocketDrain", &TunnelBridgeWrap::NotifySocketDrain)});
    exports.Set("TunnelBridge", func);
    return exports;
  }

  TunnelBridgeWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TunnelBridgeWrap>(info) {}

  ~TunnelBridgeWrap() override { bridge_.Stop(); }

private:
  Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
        !info[2].IsFunction() || !info[3].IsFunction()) {
      Napi::TypeError::New(env, "Expected (tunFd, mtu, onSocketWrite, onError)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    bridge_.Stop();

    const int tun_fd = info[0].As<Napi::Number>().Int32Value();
    const size_t mtu = info[1].As<Napi::Number>().Uint32Value();
    std::string error;
    if (!bridge_.Start(env,
                       tun_fd,
                       mtu,
                       info[2].As<Napi::Function>(),
                       info[3].As<Napi::Function>(),
                       error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    bridge_.Stop();
    return info.Env().Undefined();
  }

  Napi::Value FeedSocket(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsBuffer()) {
      Napi::TypeError::New(env, "Expected buffer").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Buffer<uint8_t> buf = info[0].As<Napi::Buffer<uint8_t>>();
    bridge_.FeedSocket(buf.Data(), buf.Length());
    return env.Undefined();
  }

  Napi::Value NotifySocketDrain(const Napi::CallbackInfo& info) {
    bridge_.NotifySocketDrain();
    return info.Env().Undefined();
  }

  TunnelBridge bridge_;
};

Napi::Object InitTunnelBridge(Napi::Env env, Napi::Object exports) {
  return TunnelBridgeWrap::Init(env, exports);
}

#endif
