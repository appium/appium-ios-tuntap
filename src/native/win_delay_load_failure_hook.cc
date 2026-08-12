// MSVC's delay-load runtime (delayimp.h) raises an unhandled structured
// exception -- VcppException(ERROR_SEVERITY_ERROR, ERROR_MOD_NOT_FOUND /
// ERROR_PROC_NOT_FOUND), surfacing as process exit code 0xC06D007E /
// 0xC06D007F -- when a delay-loaded DLL, or a specific exported function
// inside it, can't be resolved at first use. Because this happens via SEH
// rather than a C++ exception or a Node-API error, it terminates the whole
// process silently: Node's own uncaughtException/unhandledRejection
// handlers never see it, and nothing is written to stdout/stderr by
// default.
//
// This installs a delay-load *failure* hook (distinct from node-gyp's own
// __pfnDliNotifyHook2 in win_delay_load_hook.cc, which only redirects the
// load target for the host executable) so that if this ever happens again
// -- for example a published prebuild resolving a node.exe export that
// isn't present on the Node.js build it's actually run against -- the
// failure is reported with the exact DLL/symbol name before the process
// dies, instead of surfacing only as an opaque exit code.

#ifdef _MSC_VER

#pragma managed(push, off)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <cstdio>
#include <delayimp.h>

namespace {

FARPROC WINAPI DelayLoadFailureHook(unsigned int event, DelayLoadInfo* info) {
  switch (event) {
    case dliFailLoadLib:
      std::fprintf(
          stderr,
          "[tuntap] Failed to delay-load '%s' (Win32 error %lu). This native "
          "addon build may be incompatible with the current Node.js "
          "install; try reinstalling appium-ios-tuntap or building it from "
          "source (npm install --build-from-source).\n",
          info->szDll, info->dwLastError);
      break;
    case dliFailGetProc:
      std::fprintf(
          stderr,
          "[tuntap] Failed to resolve '%s' in '%s' (Win32 error %lu). This "
          "native addon build may be incompatible with the current Node.js "
          "install; try reinstalling appium-ios-tuntap or building it from "
          "source (npm install --build-from-source).\n",
          info->dlp.fImportByName ? info->dlp.szProcName : "(ordinal import)",
          info->szDll, info->dwLastError);
      break;
    default:
      break;
  }
  // Returning NULL preserves the default behavior -- the delay-load runtime
  // still raises its structured exception afterward. This hook only adds a
  // diagnostic message before that happens; it doesn't change outcomes on
  // machines where resolution succeeds.
  return NULL;
}

}  // namespace

decltype(__pfnDliFailureHook2) __pfnDliFailureHook2 = DelayLoadFailureHook;

#pragma managed(pop)

#endif  // _MSC_VER
