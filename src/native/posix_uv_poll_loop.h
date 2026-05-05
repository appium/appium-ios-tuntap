#pragma once

#if defined(__APPLE__) || defined(__linux__)

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <uv.h>

#include "tun_backend.h"

// Shared POSIX receive-loop driver used by Linux and macOS backends.
//
// Wraps a single `uv_poll_t` registered against the TUN file descriptor.
// On readable events the supplied `read_fn` is invoked; full packets are
// forwarded to `on_packet`, fatal failures stop the loop and report through
// `on_error`. The handle is destroyed asynchronously via `uv_close`, which is
// the only safe way to free a libuv handle.
class PosixUvPollLoop {
public:
  using ReadFn = std::function<ReadPacketStatus(size_t /*max_payload*/,
                                                std::vector<uint8_t>& /*out*/,
                                                std::string& /*error*/)>;

  PosixUvPollLoop() = default;
  ~PosixUvPollLoop();

  PosixUvPollLoop(const PosixUvPollLoop&) = delete;
  PosixUvPollLoop& operator=(const PosixUvPollLoop&) = delete;

  // Starts polling `fd` on `loop`. Returns false (and leaves the instance
  // unstarted) on failure; the caller must inspect `error` for diagnostics.
  bool Start(uv_loop_t* loop,
             int fd,
             size_t buffer_size,
             ReadFn read_fn,
             TunPlatformBackend::PacketCallback on_packet,
             TunPlatformBackend::ErrorCallback on_error,
             std::string& error);

  // Stops the poll handle and clears callbacks. Safe to call when not started
  // and safe to call multiple times.
  void Stop();

private:
  struct State {
    size_t buffer_size = 0;
    ReadFn read_fn;
    TunPlatformBackend::PacketCallback on_packet;
    TunPlatformBackend::ErrorCallback on_error;
  };

  static void OnPoll(uv_poll_t* handle, int status, int events);
  static void OnHandleClosed(uv_handle_t* handle);

  uv_poll_t* handle_ = nullptr;
  std::unique_ptr<State> state_;
};

// Configures `fd` for non-blocking I/O. Returns false and writes `error` on
// failure.
bool SetNonBlocking(int fd, std::string& error);

#endif
