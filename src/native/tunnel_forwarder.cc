#include "tunnel_forwarder.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <arpa/inet.h>
#else
#include <winsock2.h>
#endif

#include <openssl/err.h>

#include "debug_log.h"
#include "ipv6_frame.h"

namespace {

constexpr char kCdTunnelMagic[] = "CDTunnel";
constexpr size_t kCdTunnelHeaderSize = 10;
constexpr size_t kMaxIngressBuffer = 256 * 1024;

#ifdef _WIN32
constexpr short kPollIn = POLLRDNORM;
constexpr short kPollOut = POLLWRNORM;
#else
constexpr short kPollIn = POLLIN;
constexpr short kPollOut = POLLOUT;
#endif

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

std::string EncodeCdTunnelMessage(const std::string& json) {
  std::string out;
  out.reserve(kCdTunnelHeaderSize + json.size());
  out.append(kCdTunnelMagic, 8);
  const uint16_t len = htons(static_cast<uint16_t>(json.size()));
  out.append(reinterpret_cast<const char*>(&len), sizeof(len));
  out.append(json);
  return out;
}

bool ParseHandshakeJson(const std::string& json, TunnelHandshakeInfo& info, std::string& error) {
  auto extract_string = [](const std::string& src, const char* key, std::string& dest) -> bool {
    const std::string needle = std::string("\"") + key + "\":\"";
    const size_t pos = src.find(needle);
    if (pos == std::string::npos) {
      return false;
    }
    const size_t start = pos + needle.size();
    const size_t end = src.find('"', start);
    if (end == std::string::npos) {
      return false;
    }
    dest = src.substr(start, end - start);
    return true;
  };

  auto extract_uint = [](const std::string& src, const char* key, uint32_t& dest) -> bool {
    const std::string needle = std::string("\"") + key + "\":";
    const size_t pos = src.find(needle);
    if (pos == std::string::npos) {
      return false;
    }
    const size_t start = pos + needle.size();
    dest = static_cast<uint32_t>(std::strtoul(src.c_str() + start, nullptr, 10));
    return true;
  };

  const size_t cp_pos = json.find("\"clientParameters\"");
  if (cp_pos == std::string::npos) {
    error = "Handshake response missing clientParameters";
    return false;
  }
  const size_t cp_start = json.find('{', cp_pos);
  const size_t cp_end = json.find('}', cp_start);
  if (cp_start == std::string::npos || cp_end == std::string::npos) {
    error = "Malformed clientParameters in handshake response";
    return false;
  }
  const std::string client_params = json.substr(cp_start, cp_end - cp_start + 1);

  if (!extract_string(client_params, "address", info.client_address) ||
      !extract_uint(client_params, "mtu", info.mtu) ||
      !extract_string(json, "serverAddress", info.server_address)) {
    error = "Failed to parse handshake response fields";
    return false;
  }

  uint32_t port = 0;
  if (!extract_uint(json, "serverRSDPort", port)) {
    error = "Failed to parse serverRSDPort";
    return false;
  }
  info.server_rsd_port = static_cast<uint16_t>(port);
  return true;
}

bool PollFd(int fd, short events, const std::atomic<bool>* running, TimePoint deadline) {
  if (fd < 0) {
    return false;
  }
#ifdef _WIN32
  WSAPOLLFD pfd {};
  pfd.fd = static_cast<SOCKET>(fd);
#else
  struct pollfd pfd {};
  pfd.fd = fd;
#endif
  pfd.events = events;
  for (;;) {
    if (running != nullptr && !running->load()) {
      return false;
    }
    const TimePoint now = Clock::now();
    if (now >= deadline) {
      return false;
    }
    const auto remaining_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
    const int timeout_ms = remaining_ms > 200 ? 200 : static_cast<int>(remaining_ms);
#ifdef _WIN32
    const int rc = WSAPoll(&pfd, 1, timeout_ms);
#else
    const int rc = poll(&pfd, 1, timeout_ms);
#endif
    if (rc > 0) {
      if ((pfd.revents & (POLLERR | POLLHUP
#ifndef _WIN32
                          | POLLNVAL
#endif
                          )) != 0) {
        return false;
      }
      return (pfd.revents & events) != 0;
    }
    if (rc == 0) {
      continue;
    }
#ifdef _WIN32
    if (WSAGetLastError() == WSAEINTR) {
#else
    if (errno == EINTR) {
#endif
      continue;
    }
    return false;
  }
}

}  // namespace

TunnelForwarder::~TunnelForwarder() {
  Stop();
}

void TunnelForwarder::Fail(const std::string& reason) {
  running_.store(false);
  if (error_reported_.exchange(true)) {
    return;
  }

  ForwarderErrorCallback cb;
  {
    std::lock_guard<std::mutex> lock(error_mutex_);
    cb = std::move(on_error_);
    on_error_ = nullptr;
  }
  if (cb) {
    cb(reason);
  }
}

bool TunnelForwarder::Connect(int tcp_fd,
                              const std::string& cert_pem,
                              const std::string& key_pem,
                              std::string& error) {
  Stop();
  return ssl_.Connect(tcp_fd, cert_pem, key_pem, kTunnelHandshakeTimeoutMs, error);
}

bool TunnelForwarder::ConnectPsk(int tcp_fd,
                                 const uint8_t* psk,
                                 size_t psk_len,
                                 const std::string& identity,
                                 std::string& error) {
  Stop();
  return ssl_.ConnectPsk(tcp_fd, psk, psk_len, identity, kTunnelHandshakeTimeoutMs, error);
}

bool TunnelForwarder::Handshake(uint32_t requested_mtu, TunnelHandshakeInfo& info, std::string& error) {
  SSL* ssl = ssl_.ssl();
  if (ssl == nullptr) {
    error = "TLS session is not connected";
    return false;
  }

  handshake_deadline_ = Clock::now() + std::chrono::milliseconds(kTunnelHandshakeTimeoutMs);

  const std::string request =
      "{\"type\":\"clientHandshakeRequest\",\"mtu\":" + std::to_string(requested_mtu) + "}";
  const std::string packet = EncodeCdTunnelMessage(request);
  if (SslWriteAll(reinterpret_cast<const uint8_t*>(packet.data()), packet.size(), false) < 0) {
    error = Clock::now() >= handshake_deadline_ ? "Tunnel handshake timeout"
                                                : "Failed to send CDTunnel handshake request";
    return false;
  }

  uint8_t header[kCdTunnelHeaderSize];
  if (SslReadExact(header, kCdTunnelHeaderSize) < 0) {
    error = Clock::now() >= handshake_deadline_ ? "Tunnel handshake timeout"
                                                : "Failed to read CDTunnel handshake header";
    return false;
  }
  if (std::memcmp(header, kCdTunnelMagic, 8) != 0) {
    error = "Invalid CDTunnel magic in handshake response";
    return false;
  }
  const uint16_t payload_len = ntohs(*reinterpret_cast<uint16_t*>(header + 8));
  std::vector<uint8_t> body(payload_len);
  if (payload_len > 0 && SslReadExact(body.data(), body.size()) < 0) {
    error = Clock::now() >= handshake_deadline_ ? "Tunnel handshake timeout"
                                                : "Failed to read CDTunnel handshake body";
    return false;
  }

  const std::string json(body.begin(), body.end());
  if (!ParseHandshakeJson(json, info, error)) {
    return false;
  }
  mtu_ = info.mtu;
  tuntap::FwdDebug("forwarder-handshake",
                   "mtu=%u server=%s rsdPort=%u",
                   info.mtu,
                   info.server_address.c_str(),
                   info.server_rsd_port);
  return true;
}

bool TunnelForwarder::StartForwarding(TunPlatformBackend* tun_backend,
                                      ForwarderErrorCallback on_error,
                                      std::string& error) {
  if (running_.load()) {
    error = "Tunnel forwarder already running";
    return false;
  }
  if (ssl_.ssl() == nullptr) {
    error = "TLS session is not connected";
    return false;
  }
  if (tun_backend == nullptr || !tun_backend->IsOpen()) {
    error = "TUN device is not open";
    return false;
  }

  if (tun_thread_.joinable()) {
    tun_thread_.join();
  }
  if (sock_thread_.joinable()) {
    sock_thread_.join();
  }

  error_reported_.store(false);
  {
    std::lock_guard<std::mutex> lock(error_mutex_);
    on_error_ = std::move(on_error);
  }

  tun_backend_ = tun_backend;
  running_.store(true);
  tun_writes_.store(0);
  ssl_reads_.store(0);
  tuntap::FwdDebug("forwarder-start", "mtu=%zu tunFd=%d", mtu_, tun_backend->GetNativeFd());
  tun_thread_ = std::thread(&TunnelForwarder::TunToDeviceLoop, this);
  sock_thread_ = std::thread(&TunnelForwarder::DeviceToTunLoop, this);
  return true;
}

void TunnelForwarder::Stop() {
  running_.store(false);

  {
    std::lock_guard<std::mutex> lock(ssl_mutex_);
    if (ssl_.ssl() != nullptr) {
      SSL_shutdown(ssl_.ssl());
    }
  }

  if (tun_thread_.joinable()) {
    tun_thread_.join();
  }
  if (sock_thread_.joinable()) {
    sock_thread_.join();
  }

  {
    std::lock_guard<std::mutex> lock(error_mutex_);
    on_error_ = nullptr;
  }

  ssl_.Close();
  tun_backend_ = nullptr;
}

ssize_t TunnelForwarder::SslReadChunk(uint8_t* buf, size_t max_len, bool only_while_running) {
  if (max_len == 0) {
    return -1;
  }

  const TimePoint deadline =
      only_while_running ? TimePoint::max() : handshake_deadline_;

  for (;;) {
    if (only_while_running && !running_.load()) {
      return -1;
    }
    if (!only_while_running && Clock::now() >= handshake_deadline_) {
      return -1;
    }

    int n = 0;
    int err = 0;
    int fd = -1;
    short poll_events = 0;

    {
      std::lock_guard<std::mutex> lock(ssl_mutex_);
      SSL* ssl = ssl_.ssl();
      if (ssl == nullptr) {
        return -1;
      }
      n = SSL_read(ssl, buf, static_cast<int>(max_len));
      if (n > 0) {
        return n;
      }
      err = SSL_get_error(ssl, n);
      if (err == SSL_ERROR_ZERO_RETURN) {
        return -1;
      }
      if (err != SSL_ERROR_WANT_READ && err != SSL_ERROR_WANT_WRITE) {
        return -1;
      }
      fd = SSL_get_fd(ssl);
      poll_events = (err == SSL_ERROR_WANT_READ) ? kPollIn : kPollOut;
    }

    const std::atomic<bool>* running = only_while_running ? &running_ : nullptr;
    if (!PollFd(fd, poll_events, running, deadline)) {
      return -1;
    }
  }
}

ssize_t TunnelForwarder::SslReadExact(uint8_t* buf, size_t len) {
  size_t got = 0;
  while (got < len) {
    const ssize_t n = SslReadChunk(buf + got, len - got, false);
    if (n < 0) {
      return -1;
    }
    got += static_cast<size_t>(n);
  }
  return static_cast<ssize_t>(got);
}

ssize_t TunnelForwarder::SslWriteAll(const uint8_t* data, size_t len, bool only_while_running) {
  size_t sent = 0;
  const TimePoint deadline =
      only_while_running ? TimePoint::max() : handshake_deadline_;

  while (sent < len) {
    if (only_while_running && !running_.load()) {
      return -1;
    }
    if (!only_while_running && Clock::now() >= handshake_deadline_) {
      return -1;
    }

    int n = 0;
    int err = 0;
    int fd = -1;
    short poll_events = 0;

    {
      std::lock_guard<std::mutex> lock(ssl_mutex_);
      SSL* ssl = ssl_.ssl();
      if (ssl == nullptr) {
        return -1;
      }
      n = SSL_write(ssl, data + sent, static_cast<int>(len - sent));
      if (n > 0) {
        sent += static_cast<size_t>(n);
        continue;
      }
      err = SSL_get_error(ssl, n);
      if (err == SSL_ERROR_ZERO_RETURN) {
        return -1;
      }
      if (err != SSL_ERROR_WANT_READ && err != SSL_ERROR_WANT_WRITE) {
        return -1;
      }
      fd = SSL_get_fd(ssl);
      poll_events = (err == SSL_ERROR_WANT_READ) ? kPollIn : kPollOut;
    }

    const std::atomic<bool>* running = only_while_running ? &running_ : nullptr;
    if (!PollFd(fd, poll_events, running, deadline)) {
      return -1;
    }
  }
  return static_cast<ssize_t>(sent);
}

TunReadResult TunnelForwarder::ReadTunPacket(std::vector<uint8_t>& out) {
  if (tun_backend_ == nullptr) {
    return TunReadResult::kFatal;
  }

  std::string error;
  const ReadPacketStatus status = tun_backend_->ReadPacket(mtu_, out, error);
  switch (status) {
    case ReadPacketStatus::Data:
      return TunReadResult::kOk;
    case ReadPacketStatus::NoData:
      tuntap::FwdDebug("forwarder-tun-wait", "fd=%d", tun_backend_->GetNativeFd());
      if (!tun_backend_->WaitReadable(running_, error)) {
        if (!error.empty()) {
          tuntap::FwdDebug("forwarder-tun-wait-error", "%s", error.c_str());
        }
        return running_.load() ? TunReadResult::kFatal : TunReadResult::kWouldBlock;
      }
      return TunReadResult::kWouldBlock;
    case ReadPacketStatus::Closed:
      return running_.load() ? TunReadResult::kFatal : TunReadResult::kWouldBlock;
    case ReadPacketStatus::Error:
      if (!error.empty()) {
        tuntap::FwdDebug("forwarder-tun-read-error", "%s", error.c_str());
      }
      return running_.load() ? TunReadResult::kFatal : TunReadResult::kWouldBlock;
  }

  return TunReadResult::kFatal;
}

ssize_t TunnelForwarder::WriteTunPacket(const uint8_t* data, size_t len) {
  if (tun_backend_ == nullptr) {
    return -1;
  }

  for (;;) {
    std::string error;
    const ssize_t n = tun_backend_->WritePacket(data, len, error);
    if (n == static_cast<ssize_t>(len)) {
      return n;
    }
    if (n < 0) {
      if (!error.empty()) {
        tuntap::FwdDebug("forwarder-tun-write-error", "%s", error.c_str());
      }
      return -1;
    }
    if (n > 0) {
      tuntap::FwdDebug("forwarder-tun-write-short", "expected=%zu actual=%zd", len, n);
      return -1;
    }

    tuntap::FwdDebug("forwarder-tun-write-blocked", "fd=%d", tun_backend_->GetNativeFd());
    if (!tun_backend_->WaitWritable(running_, error)) {
      if (!error.empty()) {
        tuntap::FwdDebug("forwarder-tun-write-wait-error", "%s", error.c_str());
      }
      return -1;
    }
  }
}

void TunnelForwarder::TunToDeviceLoop() {
  std::vector<uint8_t> packet;

  while (running_.load()) {
    const TunReadResult read_result = ReadTunPacket(packet);
    if (read_result == TunReadResult::kFatal) {
      if (running_.load()) {
        Fail("TUN read failed in tun-to-device loop");
      }
      return;
    }
    if (read_result != TunReadResult::kOk || packet.empty()) {
      continue;
    }
    if (SslWriteAll(packet.data(), packet.size()) < 0) {
      if (running_.load()) {
        Fail("SSL write failed in tun-to-device loop");
      }
      return;
    }
    const uint64_t count = ++tun_writes_;
    if (count == 1 || count % 200 == 0) {
      tuntap::FwdDebug("forwarder-tun-write", "len=%zu packets=%llu", packet.size(),
                       static_cast<unsigned long long>(count));
    }
  }
}

void TunnelForwarder::DeviceToTunLoop() {
  std::vector<uint8_t> ingress;
  uint8_t chunk[16384];

  while (running_.load()) {
    const ssize_t n = SslReadChunk(chunk, sizeof(chunk));
    if (n < 0) {
      if (running_.load()) {
        Fail("SSL read failed in device-to-tun loop");
      }
      return;
    }
    if (n == 0) {
      continue;
    }

    const uint64_t count = ++ssl_reads_;
    if (count == 1 || count % 200 == 0) {
      tuntap::FwdDebug("forwarder-ssl-read", "len=%zd chunks=%llu", n,
                       static_cast<unsigned long long>(count));
    }

    if (ingress.size() + static_cast<size_t>(n) > kMaxIngressBuffer) {
      Fail("SSL ingress buffer overflow");
      return;
    }
    ingress.insert(ingress.end(), chunk, chunk + n);

    std::vector<std::vector<uint8_t>> frames;
    ipv6_frame::DrainFrames(ingress, frames);

    for (const auto& frame : frames) {
      if (WriteTunPacket(frame.data(), frame.size()) < 0) {
        if (running_.load()) {
          Fail("TUN write failed in device-to-tun loop");
        }
        return;
      }
    }
  }
}

// --- N-API wrapper ---

class TunnelForwarderWrap : public Napi::ObjectWrap<TunnelForwarderWrap> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env,
                    "TunnelForwarder",
                    {InstanceMethod("connect", &TunnelForwarderWrap::Connect),
                     InstanceMethod("connectPsk", &TunnelForwarderWrap::ConnectPsk),
                     InstanceMethod("handshake", &TunnelForwarderWrap::Handshake),
                     InstanceMethod("startForwarding", &TunnelForwarderWrap::StartForwarding),
                     InstanceMethod("stop", &TunnelForwarderWrap::Stop)});
    exports.Set("TunnelForwarder", func);
    return exports;
  }

  TunnelForwarderWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TunnelForwarderWrap>(info) {}

  ~TunnelForwarderWrap() override {
    ReleaseErrorTsfn();
    forwarder_.Stop();
  }

private:
  void ReleaseErrorTsfn() {
    if (error_tsfn_) {
      error_tsfn_.Release();
      error_tsfn_ = nullptr;
    }
  }

  void ReportError(std::string message) {
    if (!error_tsfn_) {
      return;
    }
    auto* copy = new std::string(std::move(message));
    const napi_status status = error_tsfn_.NonBlockingCall(
        copy,
        [](Napi::Env env, Napi::Function js_callback, std::string* msg) {
          js_callback.Call({Napi::String::New(env, *msg)});
          delete msg;
        });
    if (status != napi_ok) {
      fprintf(stderr, "TunnelForwarder error (callback queue full): %s\n", copy->c_str());
      delete copy;
    }
  }

  Napi::Value Connect(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsString()) {
      Napi::TypeError::New(env, "Expected (tcpFd, certPem, keyPem)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string error;
    if (!forwarder_.Connect(info[0].As<Napi::Number>().Int32Value(),
                            info[1].As<Napi::String>().Utf8Value(),
                            info[2].As<Napi::String>().Utf8Value(),
                            error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value ConnectPsk(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBuffer()) {
      Napi::TypeError::New(env, "Expected (tcpFd, pskBuffer[, identity])")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string identity;
    if (info.Length() >= 3 && info[2].IsString()) {
      identity = info[2].As<Napi::String>().Utf8Value();
    }

    Napi::Buffer<uint8_t> psk = info[1].As<Napi::Buffer<uint8_t>>();
    std::string error;
    if (!forwarder_.ConnectPsk(info[0].As<Napi::Number>().Int32Value(),
                               psk.Data(),
                               psk.Length(),
                               identity,
                               error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value Handshake(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "Expected requestedMtu number").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    TunnelHandshakeInfo handshake{};
    std::string error;
    if (!forwarder_.Handshake(info[0].As<Napi::Number>().Uint32Value(), handshake, error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
      return env.Undefined();
    }

    Napi::Object client_params = Napi::Object::New(env);
    client_params.Set("address", handshake.client_address);
    client_params.Set("mtu", handshake.mtu);

    Napi::Object result = Napi::Object::New(env);
    result.Set("clientParameters", client_params);
    result.Set("serverAddress", handshake.server_address);
    result.Set("serverRSDPort", handshake.server_rsd_port);
    return result;
  }

  Napi::Value StartForwarding(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsExternal()) {
      Napi::TypeError::New(env, "Expected (tunForwardingHandle[, onError])").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    ReleaseErrorTsfn();

    Napi::Function on_error = Napi::Function::New(env, [](const Napi::CallbackInfo&) {});
    if (info.Length() >= 2 && info[1].IsFunction()) {
      on_error = info[1].As<Napi::Function>();
    }

    error_tsfn_ = Napi::ThreadSafeFunction::New(env,
                                                on_error,
                                                "TunnelForwarderOnError",
                                                0,
                                                1);

    TunPlatformBackend* tun_backend = info[0].As<Napi::External<TunPlatformBackend>>().Data();
    std::string error;
    ForwarderErrorCallback callback = [this](std::string msg) { ReportError(std::move(msg)); };
    if (!forwarder_.StartForwarding(tun_backend, std::move(callback), error)) {
      ReleaseErrorTsfn();
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    forwarder_.Stop();
    ReleaseErrorTsfn();
    return info.Env().Undefined();
  }

  TunnelForwarder forwarder_;
  Napi::ThreadSafeFunction error_tsfn_;
};

Napi::Object InitTunnelForwarder(Napi::Env env, Napi::Object exports) {
  return TunnelForwarderWrap::Init(env, exports);
}
