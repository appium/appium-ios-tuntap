// An unresolvable delay-loaded DLL or export kills the process via SEH (exit
// code 0xC06D007E/F) before any JS handler sees it, with nothing logged. This
// failure hook prints the offending DLL/symbol first, turning an opaque exit
// code into a diagnosable one. Distinct from node-gyp's __pfnDliNotifyHook2
// in win_delay_load_hook.cc, which only redirects the load target.

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
      std::fprintf(stderr,
                   "[tuntap] Failed to delay-load '%s' (Win32 error %lu). This native "
                   "addon build may be incompatible with the current Node.js "
                   "install; try reinstalling appium-ios-tuntap or building it from "
                   "source (npm install --build-from-source).\n",
                   info->szDll, info->dwLastError);
      break;
    case dliFailGetProc:
      std::fprintf(stderr,
                   "[tuntap] Failed to resolve '%s' in '%s' (Win32 error %lu). This "
                   "native addon build may be incompatible with the current Node.js "
                   "install; try reinstalling appium-ios-tuntap or building it from "
                   "source (npm install --build-from-source).\n",
                   info->dlp.fImportByName ? info->dlp.szProcName : "(ordinal import)", info->szDll, info->dwLastError);
      break;
    default:
      break;
  }
  // NULL keeps the default behavior: the runtime still raises afterward.
  return NULL;
}

}  // namespace

decltype(__pfnDliFailureHook2) __pfnDliFailureHook2 = DelayLoadFailureHook;

#pragma managed(pop)

#endif  // _MSC_VER
