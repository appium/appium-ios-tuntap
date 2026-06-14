#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <openssl/ssl.h>

#include <string>

/** Lockdown-style TLS client (host cert + key PEM, TLS 1.2). */
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

  void Close();

  SSL* ssl() const { return ssl_; }

private:
  SSL_CTX* ctx_ = nullptr;
  SSL* ssl_ = nullptr;
  int owned_fd_ = -1;
};

#endif
