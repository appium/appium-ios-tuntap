#ifdef _WIN32

#include "wintun_loader.h"

#include <vector>

namespace {

constexpr LPCWSTR kWintunDllName = L"wintun.dll";

// Returns the directory that contains the addon module that this code is
// linked into. Used to locate `wintun.dll` shipped next to `tuntap.node`.
std::wstring GetAddonDirectory() {
  HMODULE module = nullptr;
  // Pass the address of any function in this translation unit so the resolver
  // returns the addon's own module rather than the host process executable.
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&GetAddonDirectory),
                          &module)) {
    return std::wstring();
  }

  std::vector<wchar_t> buffer(MAX_PATH);
  for (;;) {
    DWORD len = GetModuleFileNameW(module, buffer.data(),
                                   static_cast<DWORD>(buffer.size()));
    if (len == 0) {
      return std::wstring();
    }
    if (len < buffer.size()) {
      buffer.resize(len);
      break;
    }
    buffer.resize(buffer.size() * 2);
  }

  std::wstring path(buffer.begin(), buffer.end());
  size_t pos = path.find_last_of(L"\\/");
  if (pos == std::wstring::npos) {
    return std::wstring();
  }
  path.resize(pos);
  return path;
}

template <typename T>
bool Resolve(HMODULE module, const char* name, T& out, std::string& error) {
  out = reinterpret_cast<T>(::GetProcAddress(module, name));
  if (!out) {
    error = std::string("Failed to resolve wintun.dll export: ") + name;
    return false;
  }
  return true;
}

} // namespace

WintunApi& WintunApi::Instance() {
  static WintunApi instance;
  return instance;
}

bool WintunApi::Load(std::string& error) {
  if (loaded_) {
    return true;
  }

  // Try addon-directory first so `wintun.dll` shipped next to `tuntap.node`
  // wins over a stale system copy.
  std::wstring addon_dir = GetAddonDirectory();
  if (!addon_dir.empty()) {
    std::wstring local = addon_dir + L"\\" + kWintunDllName;
    if (TryLoadFrom(local.c_str())) {
      return ResolveEntryPoints(error);
    }
  }

  // Fall back to the OS-default search list (Application dir, System32, …)
  // by passing only the file name.
  if (TryLoadFrom(kWintunDllName)) {
    return ResolveEntryPoints(error);
  }

  error = std::string("Failed to load wintun.dll: ") + FormatLastError(::GetLastError()) +
          ". Make sure wintun.dll is shipped next to tuntap.node or installed system-wide.";
  return false;
}

bool WintunApi::TryLoadFrom(LPCWSTR path) {
  module_ = ::LoadLibraryExW(path, nullptr,
                             LOAD_LIBRARY_SEARCH_APPLICATION_DIR |
                                 LOAD_LIBRARY_SEARCH_SYSTEM32 |
                                 LOAD_LIBRARY_SEARCH_USER_DIRS);
  return module_ != nullptr;
}

bool WintunApi::ResolveEntryPoints(std::string& error) {
  if (!module_) {
    error = "wintun.dll module handle is null";
    return false;
  }

  if (!Resolve(module_, "WintunCreateAdapter", CreateAdapter, error) ||
      !Resolve(module_, "WintunOpenAdapter", OpenAdapter, error) ||
      !Resolve(module_, "WintunCloseAdapter", CloseAdapter, error) ||
      !Resolve(module_, "WintunGetRunningDriverVersion", GetRunningDriverVersion, error) ||
      !Resolve(module_, "WintunStartSession", StartSession, error) ||
      !Resolve(module_, "WintunEndSession", EndSession, error) ||
      !Resolve(module_, "WintunGetReadWaitEvent", GetReadWaitEvent, error) ||
      !Resolve(module_, "WintunReceivePacket", ReceivePacket, error) ||
      !Resolve(module_, "WintunReleaseReceivePacket", ReleaseReceivePacket, error) ||
      !Resolve(module_, "WintunAllocateSendPacket", AllocateSendPacket, error) ||
      !Resolve(module_, "WintunSendPacket", SendPacket, error)) {
    ::FreeLibrary(module_);
    module_ = nullptr;
    return false;
  }

  loaded_ = true;
  return true;
}

std::string FormatLastError(DWORD error_code) {
  if (error_code == 0) {
    return "no error";
  }

  LPSTR buffer = nullptr;
  DWORD len = ::FormatMessageA(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error_code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPSTR>(&buffer), 0, nullptr);

  std::string message;
  if (len && buffer) {
    message.assign(buffer, len);
    ::LocalFree(buffer);
    while (!message.empty() && (message.back() == '\n' || message.back() == '\r')) {
      message.pop_back();
    }
  }

  if (message.empty()) {
    message = "Unknown error";
  }
  return message + " (code=" + std::to_string(error_code) + ")";
}

std::wstring Utf8ToUtf16(const std::string& utf8) {
  if (utf8.empty()) {
    return std::wstring();
  }

  int len = ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(),
                                  static_cast<int>(utf8.size()), nullptr, 0);
  if (len <= 0) {
    return std::wstring();
  }

  std::wstring result(static_cast<size_t>(len), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(),
                        static_cast<int>(utf8.size()), result.data(), len);
  return result;
}

#endif
