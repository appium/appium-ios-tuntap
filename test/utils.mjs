import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

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
export async function isAdministrator() {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    await execFileAsync('net', ['session'], {windowsHide: true});
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
export async function hasPrivileges() {
  return process.platform === 'win32' ? await isAdministrator() : isRoot();
}
