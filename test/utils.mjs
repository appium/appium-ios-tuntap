import {execFileSync} from 'node:child_process';

/**
 * Returns true if the current process is running as root on POSIX systems.
 * Returns false on Windows (use {@link isAdministrator} instead).
 */
export function isRoot() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
}

/**
 * Returns true if the current process has Administrator privileges on Windows.
 * Implementation runs `net session`, which exits 0 only when elevated.
 */
export function isAdministrator() {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    execFileSync('net', ['session'], {stdio: 'ignore', windowsHide: true});
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the current process holds the privileges required to open
 * and configure a TUN device on the host platform (root on POSIX,
 * Administrator on Windows).
 */
export function hasPrivileges() {
  return process.platform === 'win32' ? isAdministrator() : isRoot();
}
