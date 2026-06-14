#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <cstddef>
#include <cstdint>
#include <openssl/ssl.h>

#include <string>
#include <vector>

/** SSL_connect and CDTunnel handshake I/O deadline (milliseconds). */
inline constexpr int kTunnelHandshakeTimeoutMs = 15000;

/** TLS client for lockdown (PEM cert) or Apple TV Remote Pairing (TLS-PSK). */
class TunnelSslClient {
public:
  TunnelSslClient() = default;
  ~TunnelSslClient();

  TunnelSslClient(const TunnelSslClient&) = delete;
  TunnelSslClient& operator=(const TunnelSslClient&) = delete;

  bool Connect(int tcp_fd,
               const std::string& cert_pem,
               const std::string& key_pem,
               int timeout_ms,
               std::string& error);

  bool ConnectPsk(int tcp_fd,
                  const uint8_t* psk,
                  size_t psk_len,
                  const std::string& identity,
                  int timeout_ms,
                  std::string& error);

  void Close();

  SSL* ssl() const { return ssl_; }

private:
  static unsigned int PskClientCallback(SSL* ssl,
                                        const char* /*hint*/,
                                        char* identity,
                                        unsigned int max_identity_len,
                                        unsigned char* psk,
                                        unsigned int max_psk_len);

  bool ConnectTls(int timeout_ms, std::string& error);

  SSL_CTX* ctx_ = nullptr;
  SSL* ssl_ = nullptr;
  int owned_fd_ = -1;
  std::vector<uint8_t> psk_key_;
  std::string psk_identity_;
};

#endif
