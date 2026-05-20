#pragma once

#ifdef _WIN32

#include <windows.h>

// RAII wrapper for a Win32 `HANDLE`. Mirrors `FileDescriptor` so backends can
// rely on the same lifetime semantics regardless of OS.
class Handle {
public:
  Handle();
  explicit Handle(HANDLE handle);
  ~Handle();

  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;

  Handle(Handle&& other) noexcept;
  Handle& operator=(Handle&& other) noexcept;

  HANDLE get() const;
  HANDLE release();
  bool is_valid() const;
  void reset(HANDLE handle = nullptr);

private:
  HANDLE handle_;
};

#endif
