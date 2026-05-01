#ifdef _WIN32

#include "handle.h"

namespace {

bool IsRealHandle(HANDLE handle) {
  return handle != nullptr && handle != INVALID_HANDLE_VALUE;
}

} // namespace

Handle::Handle() : handle_(nullptr) {}

Handle::Handle(HANDLE handle) : handle_(handle) {}

Handle::~Handle() {
  if (IsRealHandle(handle_)) {
    ::CloseHandle(handle_);
  }
}

Handle::Handle(Handle&& other) noexcept : handle_(other.handle_) {
  other.handle_ = nullptr;
}

Handle& Handle::operator=(Handle&& other) noexcept {
  if (this != &other) {
    if (IsRealHandle(handle_)) {
      ::CloseHandle(handle_);
    }
    handle_ = other.handle_;
    other.handle_ = nullptr;
  }
  return *this;
}

HANDLE Handle::get() const {
  return handle_;
}

HANDLE Handle::release() {
  HANDLE temp = handle_;
  handle_ = nullptr;
  return temp;
}

bool Handle::is_valid() const {
  return IsRealHandle(handle_);
}

void Handle::reset(HANDLE handle) {
  if (IsRealHandle(handle_)) {
    ::CloseHandle(handle_);
  }
  handle_ = handle;
}

#endif
