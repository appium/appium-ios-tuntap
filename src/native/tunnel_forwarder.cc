#include "tunnel_forwarder.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <limits>
#ifndef _WIN32
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <arpa/inet.h>
#else
#include <winsock2.h>
#include <ws2tcpip.h>
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

#ifdef _WIN32
// Dials a host/port with plain WinSock. Windows can't recover the OS socket
// from a JS net.Socket (`_handle.fd` is -1; reading V8 internals to find it
// is not ABI-stable and broke a prebuild across a Node upgrade), so the JS
// layer instead bridges its socket through a loopback listener and passes
// that address here. See forwarder.ts bridgeToNative.
bool ConnectRawTcp(const std::string& host, uint16_t port, int& fd, std::string& error) {
  struct addrinfo hints {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;

  struct addrinfo* resolved = nullptr;
  const std::string port_str = std::to_string(port);
  const int gai_rc = getaddrinfo(host.c_str(), port_str.c_str(), &hints, &resolved);
  if (gai_rc != 0 || resolved == nullptr) {
    error = "Failed to resolve '" + host + "': getaddrinfo error " + std::to_string(gai_rc);
    return false;
  }

  SOCKET sock = INVALID_SOCKET;
  int last_wsa_error = 0;
  for (const struct addrinfo* addr = resolved; addr != nullptr; addr = addr->ai_next) {
    sock = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
    if (sock == INVALID_SOCKET) {
      last_wsa_error = WSAGetLastError();
      continue;
    }
    if (connect(sock, addr->ai_addr, static_cast<int>(addr->ai_addrlen)) == 0) {
      break;
    }
    last_wsa_error = WSAGetLastError();
    closesocket(sock);
    sock = INVALID_SOCKET;
  }
  freeaddrinfo(resolved);

  if (sock == INVALID_SOCKET) {
    error = "Failed to connect to " + host + ":" + port_str + " (WSA error " +
            std::to_string(last_wsa_error) + ")";
    return false;
  }

  // Handshake frames are small; don't let Nagle delay them (best effort).
  const BOOL no_delay = TRUE;
  setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&no_delay),
             sizeof(no_delay));

  const uintptr_t raw_fd = static_cast<uintptr_t>(sock);
  if (raw_fd > static_cast<uintptr_t>(std::numeric_limits<int>::max())) {
    closesocket(sock);
    error = "Connected socket handle is too large for OpenSSL fd API";
    return false;
  }

  fd = static_cast<int>(raw_fd);
  return true;
}
#endif

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

#ifdef _WIN32
bool IsIcmpv6NeighborDiscovery(const uint8_t* data, size_t len) {
  if (data == nullptr || len < 41 || (data[0] >> 4) != 6) {
    return false;
  }
  // This forwarder only handles simple IPv6 packets with no extension-header
  // parsing today. That is enough for Windows NDP packets from WinTun.
  if (data[6] != 58) {
    return false;
  }
  const uint8_t icmp_type = data[40];
  return icmp_type >= 133 && icmp_type <= 137;
}

bool IsIpv6Multicast(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 40 && (data[0] >> 4) == 6 && data[24] == 0xff;
}

bool IsIpv6Packet(const uint8_t* data, size_t len) {
  return data != nullptr && len >= 40 && (data[0] >> 4) == 6;
}

uint32_t AddChecksumBytes(uint32_t sum, const uint8_t* data, size_t len) {
  size_t i = 0;
  for (; i + 1 < len; i += 2) {
    sum += static_cast<uint16_t>((data[i] << 8) | data[i + 1]);
  }
  if (i < len) {
    sum += static_cast<uint16_t>(data[i] << 8);
  }
  return sum;
}

uint16_t FinishChecksum(uint32_t sum) {
  while ((sum >> 16) != 0) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return static_cast<uint16_t>(~sum);
}

uint16_t ComputeIpv6TransportChecksum(const uint8_t* packet, size_t len, uint8_t protocol) {
  if (packet == nullptr || len < 40 || (packet[0] >> 4) != 6) {
    return 0;
  }

  const uint16_t payload_len = static_cast<uint16_t>((packet[4] << 8) | packet[5]);
  if (payload_len == 0 || len < 40 + payload_len) {
    return 0;
  }

  uint32_t sum = 0;
  sum = AddChecksumBytes(sum, packet + 8, 16);
  sum = AddChecksumBytes(sum, packet + 24, 16);
  sum += static_cast<uint16_t>(payload_len & 0xffff);
  sum += protocol;
  sum = AddChecksumBytes(sum, packet + 40, payload_len);
  return FinishChecksum(sum);
}

bool NormalizeTcpChecksum(std::vector<uint8_t>& packet, uint16_t& old_checksum, uint16_t& new_checksum) {
  if (packet.size() < 60 || (packet[0] >> 4) != 6 || packet[6] != 6) {
    return false;
  }

  const uint16_t payload_len = static_cast<uint16_t>((packet[4] << 8) | packet[5]);
  if (payload_len < 20 || packet.size() < 40 + payload_len) {
    return false;
  }

  constexpr size_t tcp_offset = 40;
  constexpr size_t checksum_offset = tcp_offset + 16;
  old_checksum =
      static_cast<uint16_t>((packet[checksum_offset] << 8) | packet[checksum_offset + 1]);
  packet[checksum_offset] = 0;
  packet[checksum_offset + 1] = 0;
  new_checksum = ComputeIpv6TransportChecksum(packet.data(), packet.size(), 6);
  packet[checksum_offset] = static_cast<uint8_t>(new_checksum >> 8);
  packet[checksum_offset + 1] = static_cast<uint8_t>(new_checksum & 0xff);
  return old_checksum != new_checksum;
}
#endif

std::string FormatIpv6Address(const uint8_t* addr) {
  char buf[40];
  std::snprintf(buf,
                sizeof(buf),
                "%02x%02x:%02x%02x:%02x%02x:%02x%02x:%02x%02x:%02x%02x:%02x%02x:%02x%02x",
                addr[0],
                addr[1],
                addr[2],
                addr[3],
                addr[4],
                addr[5],
                addr[6],
                addr[7],
                addr[8],
                addr[9],
                addr[10],
                addr[11],
                addr[12],
                addr[13],
                addr[14],
                addr[15]);
  return buf;
}

void DebugIpv6Packet(const char* tag, const uint8_t* data, size_t len, uint64_t count) {
  if (!tuntap::DebugEnabled()) {
    return;
  }
  if (data == nullptr || len < 40 || (data[0] >> 4) != 6) {
    tuntap::FwdDebug(tag, "len=%zu packets=%llu non-ipv6", len,
                     static_cast<unsigned long long>(count));
    return;
  }
  const uint16_t payload_len = static_cast<uint16_t>((data[4] << 8) | data[5]);
  const std::string src = FormatIpv6Address(data + 8);
  const std::string dst = FormatIpv6Address(data + 24);

  if (data[6] == 6 && len >= 60) {
    const size_t tcp_offset = 40;
    const uint16_t src_port = static_cast<uint16_t>((data[tcp_offset] << 8) | data[tcp_offset + 1]);
    const uint16_t dst_port =
        static_cast<uint16_t>((data[tcp_offset + 2] << 8) | data[tcp_offset + 3]);
    const uint8_t flags = data[tcp_offset + 13];
    tuntap::FwdDebug(tag,
                     "len=%zu packets=%llu next=%u payload=%u %s:%u -> %s:%u flags=0x%02x",
                     len,
                     static_cast<unsigned long long>(count),
                     data[6],
                     payload_len,
                     src.c_str(),
                     src_port,
                     dst.c_str(),
                     dst_port,
                     flags);
    return;
  }

  tuntap::FwdDebug(tag,
                   "len=%zu packets=%llu next=%u payload=%u %s -> %s",
                   len,
                   static_cast<unsigned long long>(count),
                   data[6],
                   payload_len,
                   src.c_str(),
                   dst.c_str());
}

void DebugSslError(const char* tag, int ssl_error) {
  unsigned long openssl_error = ERR_get_error();
#ifdef _WIN32
  const int socket_error = WSAGetLastError();
#else
  const int socket_error = errno;
#endif
  const char* reason = openssl_error == 0 ? nullptr : ERR_reason_error_string(openssl_error);
  tuntap::FwdDebug(tag,
                   "ssl_error=%d openssl=%lu reason=%s socket_error=%d",
                   ssl_error,
                   openssl_error,
                   reason == nullptr ? "(none)" : reason,
                   socket_error);
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
  tun_drops_.store(0);
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
        DebugSslError("forwarder-ssl-read-close", err);
        return -1;
      }
      if (err != SSL_ERROR_WANT_READ && err != SSL_ERROR_WANT_WRITE) {
        DebugSslError("forwarder-ssl-read-error", err);
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
        DebugSslError("forwarder-ssl-write-close", err);
        return -1;
      }
      if (err != SSL_ERROR_WANT_READ && err != SSL_ERROR_WANT_WRITE) {
        DebugSslError("forwarder-ssl-write-error", err);
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
#ifdef _WIN32
    if (!IsIpv6Packet(packet.data(), packet.size())) {
      const uint64_t count = ++tun_drops_;
      if (count <= 20 || count % 200 == 0) {
        DebugIpv6Packet("forwarder-tun-drop-nonipv6", packet.data(), packet.size(), count);
      }
      continue;
    }
    if (IsIpv6Multicast(packet.data(), packet.size())) {
      const uint64_t count = ++tun_drops_;
      if (count <= 20 || count % 200 == 0) {
        DebugIpv6Packet("forwarder-tun-drop-mcast", packet.data(), packet.size(), count);
      }
      continue;
    }
    if (IsIcmpv6NeighborDiscovery(packet.data(), packet.size())) {
      const uint64_t count = ++tun_drops_;
      if (count <= 20 || count % 200 == 0) {
        DebugIpv6Packet("forwarder-tun-drop-ndp", packet.data(), packet.size(), count);
      }
      continue;
    }
    uint16_t old_checksum = 0;
    uint16_t new_checksum = 0;
    const bool checksum_changed = NormalizeTcpChecksum(packet, old_checksum, new_checksum);
#endif
    if (SslWriteAll(packet.data(), packet.size()) < 0) {
      if (running_.load()) {
        Fail("SSL write failed in tun-to-device loop");
      }
      return;
    }
    const uint64_t count = ++tun_writes_;
    if (count <= 100 || count % 200 == 0) {
      DebugIpv6Packet("forwarder-tun-write", packet.data(), packet.size(), count);
#ifdef _WIN32
      tuntap::FwdDebug("forwarder-tcp-checksum",
                       "packets=%llu changed=%s old=0x%04x new=0x%04x",
                       static_cast<unsigned long long>(count),
                       checksum_changed ? "true" : "false",
                       old_checksum,
                       new_checksum);
#endif
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

namespace {

// Connect and handshake block on socket I/O, so they must run off the JS
// thread: on Windows their bytes flow through the JS-pumped loopback bridge,
// which a blocked event loop could never deliver. Each worker keeps a
// persistent ref to the wrap so the forwarder outlives the async work.

#ifdef _WIN32
class ConnectHostWorker : public Napi::AsyncWorker {
public:
  ConnectHostWorker(Napi::Object receiver,
                    TunnelForwarder& forwarder,
                    std::string host,
                    uint16_t port,
                    std::string cert_pem,
                    std::string key_pem,
                    Napi::Promise::Deferred deferred)
      : Napi::AsyncWorker(receiver.Env()),
        receiver_(Napi::Persistent(receiver)),
        forwarder_(forwarder),
        host_(std::move(host)),
        port_(port),
        cert_pem_(std::move(cert_pem)),
        key_pem_(std::move(key_pem)),
        deferred_(deferred) {}

  void Execute() override {
    std::string error;
    int fd = -1;
    if (!ConnectRawTcp(host_, port_, fd, error)) {
      SetError(error);
      return;
    }
    const bool ok = forwarder_.Connect(fd, cert_pem_, key_pem_, error);
    // TunnelSslClient duplicates the fd (WSADuplicateSocketW) and owns the
    // duplicate, so the original is ours to close either way.
    closesocket(static_cast<SOCKET>(fd));
    if (!ok) {
      SetError(error);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
  Napi::ObjectReference receiver_;
  TunnelForwarder& forwarder_;
  std::string host_;
  uint16_t port_;
  std::string cert_pem_;
  std::string key_pem_;
  Napi::Promise::Deferred deferred_;
};

class ConnectPskHostWorker : public Napi::AsyncWorker {
public:
  ConnectPskHostWorker(Napi::Object receiver,
                       TunnelForwarder& forwarder,
                       std::string host,
                       uint16_t port,
                       std::vector<uint8_t> psk,
                       std::string identity,
                       Napi::Promise::Deferred deferred)
      : Napi::AsyncWorker(receiver.Env()),
        receiver_(Napi::Persistent(receiver)),
        forwarder_(forwarder),
        host_(std::move(host)),
        port_(port),
        psk_(std::move(psk)),
        identity_(std::move(identity)),
        deferred_(deferred) {}

  void Execute() override {
    std::string error;
    int fd = -1;
    if (!ConnectRawTcp(host_, port_, fd, error)) {
      SetError(error);
      return;
    }
    const bool ok = forwarder_.ConnectPsk(fd, psk_.data(), psk_.size(), identity_, error);
    closesocket(static_cast<SOCKET>(fd));
    if (!ok) {
      SetError(error);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
  Napi::ObjectReference receiver_;
  TunnelForwarder& forwarder_;
  std::string host_;
  uint16_t port_;
  std::vector<uint8_t> psk_;
  std::string identity_;
  Napi::Promise::Deferred deferred_;
};
#endif  // _WIN32

class HandshakeWorker : public Napi::AsyncWorker {
public:
  HandshakeWorker(Napi::Object receiver,
                  TunnelForwarder& forwarder,
                  uint32_t requested_mtu,
                  Napi::Promise::Deferred deferred)
      : Napi::AsyncWorker(receiver.Env()),
        receiver_(Napi::Persistent(receiver)),
        forwarder_(forwarder),
        requested_mtu_(requested_mtu),
        deferred_(deferred) {}

  void Execute() override {
    std::string error;
    if (!forwarder_.Handshake(requested_mtu_, handshake_, error)) {
      SetError(error);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object client_params = Napi::Object::New(env);
    client_params.Set("address", handshake_.client_address);
    client_params.Set("mtu", handshake_.mtu);

    Napi::Object result = Napi::Object::New(env);
    result.Set("clientParameters", client_params);
    result.Set("serverAddress", handshake_.server_address);
    result.Set("serverRSDPort", handshake_.server_rsd_port);
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

private:
  Napi::ObjectReference receiver_;
  TunnelForwarder& forwarder_;
  uint32_t requested_mtu_;
  TunnelHandshakeInfo handshake_{};
  Napi::Promise::Deferred deferred_;
};

}  // namespace

class TunnelForwarderWrap : public Napi::ObjectWrap<TunnelForwarderWrap> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env,
                    "TunnelForwarder",
                    {InstanceMethod("connect", &TunnelForwarderWrap::Connect),
                     InstanceMethod("connectHost", &TunnelForwarderWrap::ConnectHost),
                     InstanceMethod("connectPsk", &TunnelForwarderWrap::ConnectPsk),
                     InstanceMethod("connectPskHost", &TunnelForwarderWrap::ConnectPskHost),
                     InstanceMethod("handshake", &TunnelForwarderWrap::Handshake),
                     InstanceMethod("startForwarding", &TunnelForwarderWrap::StartForwarding),
                     InstanceMethod("stop", &TunnelForwarderWrap::Stop)});
    exports.Set("TunnelForwarder", func);
    return exports;
  }

  TunnelForwarderWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TunnelForwarderWrap>(info) {}

  ~TunnelForwarderWrap() override {
    forwarder_.Stop();
    ReleaseErrorTsfn();
  }

private:
  void ReleaseErrorTsfn() {
    std::lock_guard<std::mutex> lock(error_tsfn_mutex_);
    if (error_tsfn_) {
      error_tsfn_.Release();
      error_tsfn_ = nullptr;
    }
  }

  void ReportError(std::string message) {
    std::lock_guard<std::mutex> lock(error_tsfn_mutex_);
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

  Napi::Value ConnectHost(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsString() ||
        !info[3].IsString()) {
      Napi::TypeError::New(env, "Expected (host, port, certPem, keyPem)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

#ifdef _WIN32
    auto deferred = Napi::Promise::Deferred::New(env);
    auto* worker =
        new ConnectHostWorker(info.This().As<Napi::Object>(),
                              forwarder_,
                              info[0].As<Napi::String>().Utf8Value(),
                              static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value()),
                              info[2].As<Napi::String>().Utf8Value(),
                              info[3].As<Napi::String>().Utf8Value(),
                              deferred);
    worker->Queue();
    return deferred.Promise();
#else
    Napi::Error::New(env, "connectHost is only supported on Windows").ThrowAsJavaScriptException();
    return env.Undefined();
#endif
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

  Napi::Value ConnectPskHost(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsBuffer()) {
      Napi::TypeError::New(env, "Expected (host, port, pskBuffer[, identity])")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::string identity;
    if (info.Length() >= 4 && info[3].IsString()) {
      identity = info[3].As<Napi::String>().Utf8Value();
    }

#ifdef _WIN32
    // Copy the PSK on the JS thread; the buffer may be collected before the
    // worker runs.
    Napi::Buffer<uint8_t> psk = info[2].As<Napi::Buffer<uint8_t>>();
    std::vector<uint8_t> psk_copy(psk.Data(), psk.Data() + psk.Length());
    auto deferred = Napi::Promise::Deferred::New(env);
    auto* worker =
        new ConnectPskHostWorker(info.This().As<Napi::Object>(),
                                 forwarder_,
                                 info[0].As<Napi::String>().Utf8Value(),
                                 static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value()),
                                 std::move(psk_copy),
                                 std::move(identity),
                                 deferred);
    worker->Queue();
    return deferred.Promise();
#else
    Napi::Error::New(env, "connectPskHost is only supported on Windows").ThrowAsJavaScriptException();
    return env.Undefined();
#endif
  }

  Napi::Value Handshake(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "Expected requestedMtu number").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Async on every platform: the CDTunnel exchange blocks on socket I/O,
    // and on Windows that I/O flows through the JS-pumped loopback bridge.
    auto deferred = Napi::Promise::Deferred::New(env);
    auto* worker = new HandshakeWorker(info.This().As<Napi::Object>(),
                                       forwarder_,
                                       info[0].As<Napi::Number>().Uint32Value(),
                                       deferred);
    worker->Queue();
    return deferred.Promise();
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

    {
      std::lock_guard<std::mutex> lock(error_tsfn_mutex_);
      error_tsfn_ = Napi::ThreadSafeFunction::New(env,
                                                  on_error,
                                                  "TunnelForwarderOnError",
                                                  0,
                                                  1);
    }

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
  std::mutex error_tsfn_mutex_;
  Napi::ThreadSafeFunction error_tsfn_;
};

Napi::Object InitTunnelForwarder(Napi::Env env, Napi::Object exports) {
  return TunnelForwarderWrap::Init(env, exports);
}
