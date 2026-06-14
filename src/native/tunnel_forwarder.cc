#if defined(__APPLE__) || defined(__linux__)

#include "tunnel_forwarder.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <arpa/inet.h>

#include <openssl/err.h>

#include "ipv6_frame.h"

namespace {

#ifdef __APPLE__
constexpr size_t kUtunHeaderSize = 4;
#endif

constexpr char kCdTunnelMagic[] = "CDTunnel";
constexpr size_t kCdTunnelHeaderSize = 10;

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

bool PollFd(int fd, short events, const std::atomic<bool>* running) {
  if (fd < 0) {
    return false;
  }
  struct pollfd pfd {};
  pfd.fd = fd;
  pfd.events = events;
  for (;;) {
    if (running != nullptr && !running->load()) {
      return false;
    }
    const int rc = poll(&pfd, 1, 200);
    if (rc > 0) {
      return (pfd.revents & events) != 0;
    }
    if (rc == 0) {
      continue;
    }
    if (errno == EINTR) {
      continue;
    }
    return false;
  }
}

}  // namespace

TunnelForwarder::~TunnelForwarder() {
  Stop();
}

bool TunnelForwarder::Connect(int tcp_fd,
                              const std::string& cert_pem,
                              const std::string& key_pem,
                              std::string& error) {
  Stop();
  return ssl_.Connect(tcp_fd, cert_pem, key_pem, error);
}

bool TunnelForwarder::Handshake(uint32_t requested_mtu, TunnelHandshakeInfo& info, std::string& error) {
  SSL* ssl = ssl_.ssl();
  if (ssl == nullptr) {
    error = "TLS session is not connected";
    return false;
  }

  const std::string request =
      "{\"type\":\"clientHandshakeRequest\",\"mtu\":" + std::to_string(requested_mtu) + "}";
  const std::string packet = EncodeCdTunnelMessage(request);
  if (SslWriteAll(reinterpret_cast<const uint8_t*>(packet.data()), packet.size(), false) < 0) {
    error = "Failed to send CDTunnel handshake request";
    return false;
  }

  uint8_t header[kCdTunnelHeaderSize];
  if (SslReadExact(header, kCdTunnelHeaderSize) < 0) {
    error = "Failed to read CDTunnel handshake header";
    return false;
  }
  if (std::memcmp(header, kCdTunnelMagic, 8) != 0) {
    error = "Invalid CDTunnel magic in handshake response";
    return false;
  }
  const uint16_t payload_len = ntohs(*reinterpret_cast<uint16_t*>(header + 8));
  std::vector<uint8_t> body(payload_len);
  if (payload_len > 0 && SslReadExact(body.data(), body.size()) < 0) {
    error = "Failed to read CDTunnel handshake body";
    return false;
  }

  const std::string json(body.begin(), body.end());
  if (!ParseHandshakeJson(json, info, error)) {
    return false;
  }
  mtu_ = info.mtu;
  return true;
}

bool TunnelForwarder::StartForwarding(int tun_fd, std::string& error) {
  if (running_.load()) {
    error = "Tunnel forwarder already running";
    return false;
  }
  if (ssl_.ssl() == nullptr) {
    error = "TLS session is not connected";
    return false;
  }
  if (tun_fd < 0) {
    error = "Invalid TUN file descriptor";
    return false;
  }

  tun_fd_ = tun_fd;
  running_.store(true);
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

  ssl_.Close();
  tun_fd_ = -1;
}

ssize_t TunnelForwarder::SslReadChunk(uint8_t* buf, size_t max_len, bool only_while_running) {
  if (max_len == 0) {
    return -1;
  }

  for (;;) {
    if (only_while_running && !running_.load()) {
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
      poll_events = (err == SSL_ERROR_WANT_READ) ? POLLIN : POLLOUT;
    }

    const std::atomic<bool>* running = only_while_running ? &running_ : nullptr;
    if (!PollFd(fd, poll_events, running)) {
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
  while (sent < len) {
    if (only_while_running && !running_.load()) {
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
      poll_events = (err == SSL_ERROR_WANT_READ) ? POLLIN : POLLOUT;
    }

    const std::atomic<bool>* running = only_while_running ? &running_ : nullptr;
    if (!PollFd(fd, poll_events, running)) {
      return -1;
    }
  }
  return static_cast<ssize_t>(sent);
}

bool TunnelForwarder::ReadTunPacket(std::vector<uint8_t>& out) {
#ifdef __APPLE__
  uint8_t frame[4 + 65535];
  const size_t cap = 4 + mtu_;
#else
  uint8_t frame[65535];
  const size_t cap = mtu_;
#endif

  while (running_.load()) {
    const ssize_t n = ::read(tun_fd_, frame, cap);
    if (n > 0) {
#ifdef __APPLE__
      if (n <= static_cast<ssize_t>(kUtunHeaderSize)) {
        continue;
      }
      out.assign(frame + kUtunHeaderSize, frame + n);
#else
      out.assign(frame, frame + n);
#endif
      return true;
    }
    if (n == 0) {
      return false;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      if (!PollFd(tun_fd_, POLLIN, &running_)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return false;
}

ssize_t TunnelForwarder::WriteTunPacket(const uint8_t* data, size_t len) {
#ifdef __APPLE__
  std::vector<uint8_t> frame(len + kUtunHeaderSize);
  const uint32_t family = htonl(AF_INET6);
  std::memcpy(frame.data(), &family, kUtunHeaderSize);
  std::memcpy(frame.data() + kUtunHeaderSize, data, len);
  size_t offset = 0;
  while (offset < frame.size()) {
    const ssize_t n = ::write(tun_fd_, frame.data() + offset, frame.size() - offset);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!PollFd(tun_fd_, POLLOUT, &running_)) {
          return -1;
        }
        continue;
      }
      return -1;
    }
    if (n == 0) {
      return -1;
    }
    offset += static_cast<size_t>(n);
  }
  return static_cast<ssize_t>(len);
#else
  size_t offset = 0;
  while (offset < len) {
    const ssize_t n = ::write(tun_fd_, data + offset, len - offset);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        if (!PollFd(tun_fd_, POLLOUT, &running_)) {
          return -1;
        }
        continue;
      }
      return -1;
    }
    if (n == 0) {
      return -1;
    }
    offset += static_cast<size_t>(n);
  }
  return static_cast<ssize_t>(len);
#endif
}

void TunnelForwarder::TunToDeviceLoop() {
  std::vector<uint8_t> packet;

  while (running_.load()) {
    if (!ReadTunPacket(packet) || packet.empty()) {
      continue;
    }
    if (SslWriteAll(packet.data(), packet.size()) < 0) {
      running_.store(false);
      return;
    }
  }
}

void TunnelForwarder::DeviceToTunLoop() {
  std::vector<uint8_t> ingress;
  uint8_t chunk[16384];

  while (running_.load()) {
    const ssize_t n = SslReadChunk(chunk, sizeof(chunk));
    if (n < 0) {
      running_.store(false);
      return;
    }
    if (n == 0) {
      continue;
    }

    ingress.insert(ingress.end(), chunk, chunk + n);

    std::vector<std::vector<uint8_t>> frames;
    ipv6_frame::DrainFrames(ingress, frames);

    for (const auto& frame : frames) {
      if (WriteTunPacket(frame.data(), frame.size()) < 0) {
        running_.store(false);
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
                     InstanceMethod("handshake", &TunnelForwarderWrap::Handshake),
                     InstanceMethod("startForwarding", &TunnelForwarderWrap::StartForwarding),
                     InstanceMethod("stop", &TunnelForwarderWrap::Stop)});
    exports.Set("TunnelForwarder", func);
    return exports;
  }

  TunnelForwarderWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TunnelForwarderWrap>(info) {}

  ~TunnelForwarderWrap() override { forwarder_.Stop(); }

private:
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
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "Expected tunFd number").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string error;
    if (!forwarder_.StartForwarding(info[0].As<Napi::Number>().Int32Value(), error)) {
      Napi::Error::New(env, error).ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    forwarder_.Stop();
    return info.Env().Undefined();
  }

  TunnelForwarder forwarder_;
};

Napi::Object InitTunnelForwarder(Napi::Env env, Napi::Object exports) {
  return TunnelForwarderWrap::Init(env, exports);
}

#endif
