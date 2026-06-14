#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <napi.h>
#include <uv.h>

/** Bidirectional utun ↔ TLS application-data bridge (IPv6 framing in native, main-thread I/O). */
class TunnelBridge {
public:
  TunnelBridge();
  ~TunnelBridge();

  TunnelBridge(const TunnelBridge&) = delete;
  TunnelBridge& operator=(const TunnelBridge&) = delete;

  bool Start(Napi::Env env,
             int tun_fd,
             size_t mtu,
             Napi::Function on_socket_write,
             Napi::Function on_error,
             std::string& error);

  void Stop();
  void FeedSocket(const uint8_t* data, size_t len);
  void NotifySocketDrain();

private:
  struct State;

  static void OnTunPoll(uv_poll_t* handle, int status, int events);

  void ProcessTunReadable();
  void ProcessSocketIngress();
  void FlushTunEgress();
  void MaybePauseTunPollForEgress();
  void UpdateTunPollInterest();
  bool ReadTunPacket(std::vector<uint8_t>& out);
  ssize_t WriteTunPacket(const uint8_t* data, size_t len);
  bool WritePacketToSocket(const std::vector<uint8_t>& packet);
  void PauseTunPoll();
  void ResumeTunPoll();
  void EmitError(const std::string& message);

  std::mutex mutex_;
  std::atomic<bool> running_{false};
  std::atomic<bool> tun_poll_paused_{false};
  std::atomic<bool> socket_blocked_{false};
  std::atomic<bool> tun_write_blocked_{false};

  int tun_fd_ = -1;
  size_t mtu_ = 1280;

  std::vector<uint8_t> socket_ingress_;
  std::vector<std::vector<uint8_t>> tun_egress_;

  Napi::FunctionReference on_socket_write_;
  Napi::FunctionReference on_error_;

  uv_poll_t tun_poll_{};
  bool poll_inited_ = false;
  State* state_ = nullptr;
};

Napi::Object InitTunnelBridge(Napi::Env env, Napi::Object exports);

#endif
