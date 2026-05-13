#if defined(__APPLE__) || defined(__linux__)

#include "posix_uv_poll_loop.h"

#include <cstdio>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <utility>

PosixUvPollLoop::~PosixUvPollLoop() {
  Stop();
}

bool PosixUvPollLoop::Start(uv_loop_t* loop,
                            int fd,
                            size_t buffer_size,
                            ReadFn read_fn,
                            TunPlatformBackend::PacketCallback on_packet,
                            TunPlatformBackend::ErrorCallback on_error,
                            std::string& error) {
  if (handle_) {
    error = "Receive loop already started";
    return false;
  }
  if (!loop || fd < 0 || buffer_size == 0) {
    error = "Invalid receive-loop parameters";
    return false;
  }

  auto state = std::make_unique<State>();
  state->buffer_size = buffer_size;
  state->read_fn = std::move(read_fn);
  state->on_packet = std::move(on_packet);
  state->on_error = std::move(on_error);

  auto handle = std::make_unique<uv_poll_t>();
  if (uv_poll_init(loop, handle.get(), fd) != 0) {
    error = "Failed to initialize poll handle";
    return false;
  }

  handle->data = state.get();
  if (uv_poll_start(handle.get(), UV_READABLE, &PosixUvPollLoop::OnPoll) != 0) {
    // The handle is initialized but not started; close it before discarding.
    uv_close(reinterpret_cast<uv_handle_t*>(handle.release()),
             [](uv_handle_t* h) { delete reinterpret_cast<uv_poll_t*>(h); });
    error = "Failed to start polling";
    return false;
  }

  state_ = std::move(state);
  handle_ = handle.release();
  return true;
}

void PosixUvPollLoop::Stop() {
  if (!handle_) {
    return;
  }

  uv_poll_stop(handle_);
  // Once handed to `uv_close`, the handle's storage is freed in
  // `OnHandleClosed`. Detach from `state_` first so any in-flight callback
  // cannot dereference freed state.
  handle_->data = nullptr;
  uv_close(reinterpret_cast<uv_handle_t*>(handle_),
           &PosixUvPollLoop::OnHandleClosed);
  handle_ = nullptr;
  state_.reset();
}

void PosixUvPollLoop::OnPoll(uv_poll_t* handle, int status, int events) {
  auto* state = static_cast<State*>(handle->data);
  if (!state) {
    return;
  }

  if (status < 0) {
    std::string err = std::string("Poll error: ") + uv_strerror(status);
    auto cb = state->on_error;
    if (cb) {
      cb(err);
    }
    return;
  }

  if (!(events & UV_READABLE) || !state->read_fn) {
    return;
  }

  std::vector<uint8_t> packet;
  std::string error;
  ReadPacketStatus rs = state->read_fn(state->buffer_size, packet, error);

  switch (rs) {
    case ReadPacketStatus::Data:
      if (state->on_packet) {
        state->on_packet(std::move(packet));
      }
      return;
    case ReadPacketStatus::NoData:
      return;
    case ReadPacketStatus::Closed:
    case ReadPacketStatus::Error: {
      auto cb = state->on_error;
      if (cb) {
        cb(rs == ReadPacketStatus::Closed ? std::string("Device closed") : error);
      }
      return;
    }
  }
}

void PosixUvPollLoop::OnHandleClosed(uv_handle_t* handle) {
  delete reinterpret_cast<uv_poll_t*>(handle);
}

bool SetNonBlocking(int fd, std::string& error) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    error = std::string("Failed to get file descriptor flags: ") + strerror(errno);
    return false;
  }
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
    error = std::string("Failed to set non-blocking mode: ") + strerror(errno);
    return false;
  }
  return true;
}

#endif
