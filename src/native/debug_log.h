#pragma once

#if defined(__APPLE__) || defined(__linux__)

namespace tuntap {

/** True when APPIUM_TUNTAP_DEBUG is `1` or `true`. */
bool DebugEnabled();

/** Log `[fwd] #N event ...` to stderr (matches JS {@link fwdDebug}). */
void FwdDebug(const char* event);

/** Log `[fwd] #N event fmt...` to stderr. */
void FwdDebug(const char* event, const char* fmt, ...) __attribute__((format(printf, 2, 3)));

}  // namespace tuntap

#endif
