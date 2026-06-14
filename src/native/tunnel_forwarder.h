#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <napi.h>

#include "tunnel_ssl.h"

struct TunnelHandshakeInfo {
  std::string client_address;
  uint32_t mtu = 1280;
  std::string server_address;
  uint16_t server_rsd_port = 0;
};

using ForwarderErrorCallback = std::function<void(std::string)>;

enum class TunReadResult {
  kOk,
  kWouldBlock,
  kFatal,
};

/**
 * pmd3/go-ios style bidirectional forwarder: blocking tun read/write loops on
 * independent threads over an OpenSSL TLS session (lockdown client cert).
 */
class TunnelForwarder {
public:
  TunnelForwarder() = default;
  ~TunnelForwarder();

  TunnelForwarder(const TunnelForwarder&) = delete;
  TunnelForwarder& operator=(const TunnelForwarder&) = delete;

  bool Connect(int tcp_fd,
               const std::string& cert_pem,
               const std::string& key_pem,
               std::string& error);

  bool Handshake(uint32_t requested_mtu, TunnelHandshakeInfo& info, std::string& error);

  bool StartForwarding(int tun_fd, ForwarderErrorCallback on_error, std::string& error);

  void Stop();

private:
  ssize_t SslReadExact(uint8_t* buf, size_t len);
  ssize_t SslWriteAll(const uint8_t* data, size_t len, bool only_while_running = true);
  void TunToDeviceLoop();
  void DeviceToTunLoop();
  TunReadResult ReadTunPacket(std::vector<uint8_t>& out);
  ssize_t WriteTunPacket(const uint8_t* data, size_t len);
  ssize_t SslReadChunk(uint8_t* buf, size_t max_len, bool only_while_running = true);
  void Fail(const std::string& reason);

  TunnelSslClient ssl_;
  std::mutex ssl_mutex_;
  std::mutex error_mutex_;
  ForwarderErrorCallback on_error_;
  std::atomic<bool> error_reported_{false};
  int tun_fd_ = -1;
  size_t mtu_ = 1280;
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> tun_writes_{0};
  std::atomic<uint64_t> ssl_reads_{0};
  std::chrono::steady_clock::time_point handshake_deadline_{};
  std::thread tun_thread_;
  std::thread sock_thread_;
};

Napi::Object InitTunnelForwarder(Napi::Env env, Napi::Object exports);

#endif
