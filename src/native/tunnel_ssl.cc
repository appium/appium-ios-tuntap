#if defined(__APPLE__) || defined(__linux__)

#include "tunnel_ssl.h"
#include "debug_log.h"

#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

namespace {

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
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) {
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  }
}

bool PollConnectFd(int fd, short events) {
  struct pollfd pfd {};
  pfd.fd = fd;
  pfd.events = events;
  for (;;) {
    const int rc = poll(&pfd, 1, 5000);
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

TunnelSslClient::~TunnelSslClient() {
  Close();
}

bool TunnelSslClient::Connect(int tcp_fd,
                              const std::string& cert_pem,
                              const std::string& key_pem,
                              std::string& error) {
  Close();
  if (tcp_fd < 0) {
    error = "Invalid TCP file descriptor";
    return false;
  }

#if OPENSSL_VERSION_NUMBER >= 0x10100000L
  if (OPENSSL_init_ssl(OPENSSL_INIT_LOAD_SSL_STRINGS | OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr) != 1) {
    error = "Failed to initialize OpenSSL";
    return false;
  }
#endif

  owned_fd_ = dup(tcp_fd);
  if (owned_fd_ < 0) {
    error = "Failed to duplicate TCP file descriptor";
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
  for (;;) {
    const int rc = SSL_connect(ssl_);
    if (rc == 1) {
      tuntap::FwdDebug("forwarder-ssl-connect", "fd=%d", owned_fd_);
      return true;
    }
    const int err = SSL_get_error(ssl_, rc);
    if (err == SSL_ERROR_WANT_READ) {
      if (!PollConnectFd(owned_fd_, POLLIN)) {
        error = "SSL_connect timed out waiting to read";
        Close();
        return false;
      }
      continue;
    }
    if (err == SSL_ERROR_WANT_WRITE) {
      if (!PollConnectFd(owned_fd_, POLLOUT)) {
        error = "SSL_connect timed out waiting to write";
        Close();
        return false;
      }
      continue;
    }
    error = std::string("SSL_connect failed: ") + ERR_reason_error_string(ERR_get_error());
    Close();
    return false;
  }
}

void TunnelSslClient::Close() {
  if (ssl_ != nullptr) {
    SSL_shutdown(ssl_);
    SSL_free(ssl_);
    ssl_ = nullptr;
  }
  if (ctx_ != nullptr) {
    SSL_CTX_free(ctx_);
    ctx_ = nullptr;
  }
  if (owned_fd_ >= 0) {
    ::close(owned_fd_);
    owned_fd_ = -1;
  }
}

#endif
