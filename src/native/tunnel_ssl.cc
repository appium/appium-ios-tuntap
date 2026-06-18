#include "tunnel_ssl.h"
#include "debug_log.h"

#ifdef _WIN32
#include <winsock2.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

#include <chrono>
#include <cerrno>
#include <cstring>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

namespace {

constexpr char kAppleTvPskCiphers[] =
    "PSK-AES256-CBC-SHA:PSK-AES128-CBC-SHA:PSK-3DES-EDE-CBC-SHA:PSK-RC4-SHA:PSK";

#ifdef _WIN32
constexpr short kPollIn = POLLRDNORM;
constexpr short kPollOut = POLLWRNORM;
#else
constexpr short kPollIn = POLLIN;
constexpr short kPollOut = POLLOUT;
#endif

bool LoadPem(SSL_CTX* ctx, const std::string& pem, bool is_cert, std::string& error) {
  BIO* bio = BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size()));
  if (bio == nullptr) {
    error = "Failed to allocate OpenSSL BIO";
    return false;
  }

  if (is_cert) {
    X509* cert = PEM_read_bio_X509(bio, nullptr, nullptr, nullptr);
    BIO_free(bio);
    if (cert == nullptr || SSL_CTX_use_certificate(ctx, cert) != 1) {
      if (cert != nullptr) {
        X509_free(cert);
      }
      error = "Failed to load TLS certificate PEM";
      return false;
    }
    X509_free(cert);
    return true;
  }

  EVP_PKEY* key = PEM_read_bio_PrivateKey(bio, nullptr, nullptr, nullptr);
  BIO_free(bio);
  if (key == nullptr || SSL_CTX_use_PrivateKey(ctx, key) != 1) {
    if (key != nullptr) {
      EVP_PKEY_free(key);
    }
    error = "Failed to load TLS private key PEM";
    return false;
  }
  EVP_PKEY_free(key);
  return true;
}

void SetNonBlockingFd(int fd) {
#ifdef _WIN32
  u_long mode = 1;
  ioctlsocket(static_cast<SOCKET>(fd), FIONBIO, &mode);
#else
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) {
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  }
#endif
}

bool PollConnectFd(int fd, short events, std::chrono::steady_clock::time_point deadline) {
#ifdef _WIN32
  WSAPOLLFD pfd {};
  pfd.fd = static_cast<SOCKET>(fd);
#else
  struct pollfd pfd {};
  pfd.fd = fd;
#endif
  pfd.events = events;
  using Clock = std::chrono::steady_clock;
  for (;;) {
    const Clock::time_point now = Clock::now();
    if (now >= deadline) {
      return false;
    }
    const auto remaining_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
    const int timeout_ms = remaining_ms > 5000 ? 5000 : static_cast<int>(remaining_ms);
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

TunnelSslClient::~TunnelSslClient() {
  Close();
}

unsigned int TunnelSslClient::PskClientCallback(SSL* ssl,
                                                const char* /*hint*/,
                                                char* identity,
                                                unsigned int max_identity_len,
                                                unsigned char* psk,
                                                unsigned int max_psk_len) {
  auto* self = static_cast<TunnelSslClient*>(SSL_get_app_data(ssl));
  if (self == nullptr || self->psk_key_.empty()) {
    return 0;
  }

  const size_t identity_len = self->psk_identity_.size();
  if (identity_len + 1 > max_identity_len) {
    return 0;
  }
  if (!self->psk_identity_.empty()) {
    std::memcpy(identity, self->psk_identity_.data(), identity_len);
  }
  identity[identity_len] = '\0';

  if (self->psk_key_.size() > max_psk_len) {
    return 0;
  }
  std::memcpy(psk, self->psk_key_.data(), self->psk_key_.size());
  return static_cast<unsigned int>(self->psk_key_.size());
}

bool TunnelSslClient::ConnectTls(int timeout_ms, std::string& error) {
  if (owned_fd_ < 0 || ssl_ == nullptr) {
    error = "TLS session is not initialized";
    return false;
  }

  const auto connect_deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);

  for (;;) {
    const int rc = SSL_connect(ssl_);
    if (rc == 1) {
      return true;
    }
    const int err = SSL_get_error(ssl_, rc);
    if (err == SSL_ERROR_WANT_READ) {
      if (!PollConnectFd(owned_fd_, kPollIn, connect_deadline)) {
        error = "SSL_connect timed out waiting to read";
        return false;
      }
      continue;
    }
    if (err == SSL_ERROR_WANT_WRITE) {
      if (!PollConnectFd(owned_fd_, kPollOut, connect_deadline)) {
        error = "SSL_connect timed out waiting to write";
        return false;
      }
      continue;
    }
    error = std::string("SSL_connect failed: ") + ERR_reason_error_string(ERR_get_error());
    return false;
  }
}

bool TunnelSslClient::Connect(int tcp_fd,
                              const std::string& cert_pem,
                              const std::string& key_pem,
                              int timeout_ms,
                              std::string& error) {
  Close();
  if (tcp_fd < 0) {
    error = "Invalid TCP file descriptor";
    return false;
  }
  if (timeout_ms <= 0) {
    timeout_ms = kTunnelHandshakeTimeoutMs;
  }

#if OPENSSL_VERSION_NUMBER >= 0x10100000L
  if (OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS | OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr) != 1) {
    error = "Failed to initialize OpenSSL";
    return false;
  }
#endif

  close_owned_fd_ = true;
#ifdef _WIN32
  owned_fd_ = tcp_fd;
  close_owned_fd_ = false;
#else
  owned_fd_ = dup(tcp_fd);
#endif
  if (owned_fd_ < 0) {
    error = "Failed to acquire TCP socket handle";
    return false;
  }
  SetNonBlockingFd(owned_fd_);

  ctx_ = SSL_CTX_new(TLS_client_method());
  if (ctx_ == nullptr) {
    error = "Failed to create SSL context";
    Close();
    return false;
  }

  SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
  SSL_CTX_set_max_proto_version(ctx_, TLS1_2_VERSION);
  SSL_CTX_set_verify(ctx_, SSL_VERIFY_NONE, nullptr);

  if (!LoadPem(ctx_, cert_pem, true, error) || !LoadPem(ctx_, key_pem, false, error)) {
    Close();
    return false;
  }
  if (SSL_CTX_check_private_key(ctx_) != 1) {
    error = "TLS certificate and private key do not match";
    Close();
    return false;
  }

  ssl_ = SSL_new(ctx_);
  if (ssl_ == nullptr) {
    error = "Failed to create SSL session";
    Close();
    return false;
  }

  SSL_set_fd(ssl_, owned_fd_);
  if (!ConnectTls(timeout_ms, error)) {
    Close();
    return false;
  }

  tuntap::FwdDebug("forwarder-ssl-connect", "fd=%d", owned_fd_);
  return true;
}

bool TunnelSslClient::ConnectPsk(int tcp_fd,
                                 const uint8_t* psk,
                                 size_t psk_len,
                                 const std::string& identity,
                                 int timeout_ms,
                                 std::string& error) {
  Close();
  if (tcp_fd < 0) {
    error = "Invalid TCP file descriptor";
    return false;
  }
  if (psk == nullptr || psk_len == 0) {
    error = "TLS-PSK key is empty";
    return false;
  }
  if (timeout_ms <= 0) {
    timeout_ms = kTunnelHandshakeTimeoutMs;
  }

#if OPENSSL_VERSION_NUMBER >= 0x10100000L
  if (OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS | OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr) != 1) {
    error = "Failed to initialize OpenSSL";
    return false;
  }
#endif

  close_owned_fd_ = true;
#ifdef _WIN32
  owned_fd_ = tcp_fd;
  close_owned_fd_ = false;
#else
  owned_fd_ = dup(tcp_fd);
#endif
  if (owned_fd_ < 0) {
    error = "Failed to acquire TCP socket handle";
    return false;
  }
  SetNonBlockingFd(owned_fd_);

  psk_key_.assign(psk, psk + psk_len);
  psk_identity_ = identity;

  ctx_ = SSL_CTX_new(TLS_client_method());
  if (ctx_ == nullptr) {
    error = "Failed to create SSL context";
    Close();
    return false;
  }

  SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
  SSL_CTX_set_max_proto_version(ctx_, TLS1_2_VERSION);
  SSL_CTX_set_verify(ctx_, SSL_VERIFY_NONE, nullptr);
  SSL_CTX_set_cipher_list(ctx_, kAppleTvPskCiphers);
  SSL_CTX_set_psk_client_callback(ctx_, &TunnelSslClient::PskClientCallback);

  ssl_ = SSL_new(ctx_);
  if (ssl_ == nullptr) {
    error = "Failed to create SSL session";
    Close();
    return false;
  }

  SSL_set_app_data(ssl_, this);
  SSL_set_fd(ssl_, owned_fd_);
  if (!ConnectTls(timeout_ms, error)) {
    Close();
    return false;
  }

  tuntap::FwdDebug("forwarder-ssl-psk-connect", "fd=%d psk_len=%zu", owned_fd_, psk_len);
  return true;
}

void TunnelSslClient::Close() {
  if (ssl_ != nullptr) {
    SSL_set_app_data(ssl_, nullptr);
    SSL_shutdown(ssl_);
    SSL_free(ssl_);
    ssl_ = nullptr;
  }
  if (ctx_ != nullptr) {
    SSL_CTX_free(ctx_);
    ctx_ = nullptr;
  }
  if (owned_fd_ >= 0 && close_owned_fd_) {
#ifdef _WIN32
    closesocket(static_cast<SOCKET>(owned_fd_));
#else
    ::close(owned_fd_);
#endif
  }
  if (owned_fd_ >= 0) {
    owned_fd_ = -1;
  }
  close_owned_fd_ = true;
  psk_key_.clear();
  psk_identity_.clear();
}
