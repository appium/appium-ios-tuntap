#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <uv.h>

#include "tun_backend.h"

class PosixUvPollLoop {
public:
  using ReadFn = std::function<ReadPacketStatus(size_t,
                                                std::vector<uint8_t>&,
                                                std::string&)>;

  PosixUvPollLoop() = default;
  ~PosixUvPollLoop();

  PosixUvPollLoop(const PosixUvPollLoop&) = delete;
  PosixUvPollLoop& operator=(const PosixUvPollLoop&) = delete;

  bool Start(uv_loop_t* loop,
             int fd,
             size_t buffer_size,
             ReadFn read_fn,
             TunPlatformBackend::PacketCallback on_packet,
             TunPlatformBackend::ErrorCallback on_error,
             std::string& error);

  void Stop();

private:
  struct State {
    size_t buffer_size = 0;
    ReadFn read_fn;
    TunPlatformBackend::PacketCallback on_packet;
    TunPlatformBackend::ErrorCallback on_error;
    PosixUvPollLoop* owner = nullptr;
  };

  static void OnPoll(uv_poll_t* handle, int status, int events);
  static void OnHandleClosed(uv_handle_t* handle);

  uv_poll_t* handle_ = nullptr;
  std::unique_ptr<State> state_;
};

bool SetNonBlocking(int fd, std::string& error);

#endif
