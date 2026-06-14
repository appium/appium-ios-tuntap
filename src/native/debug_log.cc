#if defined(__APPLE__) || defined(__linux__)

#include "debug_log.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

namespace tuntap {
namespace {

std::once_flag g_init;
bool g_debug = false;
uint64_t g_seq = 0;
std::mutex g_log_mutex;

void InitDebug() {
  const char* value = std::getenv("APPIUM_TUNTAP_DEBUG");
  g_debug = value != nullptr && (std::strcmp(value, "1") == 0 || std::strcmp(value, "true") == 0);
}

}  // namespace

bool DebugEnabled() {
  std::call_once(g_init, InitDebug);
  return g_debug;
}

void FwdDebug(const char* event) {
  if (!DebugEnabled()) {
    return;
  }

  std::lock_guard<std::mutex> lock(g_log_mutex);
  fprintf(stderr, "[fwd] #%llu %s\n", static_cast<unsigned long long>(++g_seq), event);
  fflush(stderr);
}

void FwdDebug(const char* event, const char* fmt, ...) {
  if (!DebugEnabled()) {
    return;
  }

  std::lock_guard<std::mutex> lock(g_log_mutex);
  fprintf(stderr, "[fwd] #%llu %s ", static_cast<unsigned long long>(++g_seq), event);

  va_list args;
  va_start(args, fmt);
  vfprintf(stderr, fmt, args);
  va_end(args);

  fputc('\n', stderr);
  fflush(stderr);
}

}  // namespace tuntap

#endif
