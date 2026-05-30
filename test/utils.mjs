import {isAdministrator} from '../lib/platform/require-admin.js';

/**
 * Returns true if the current process is running as root on POSIX systems.
 * Returns false on Windows (use {@link isAdministrator} instead).
 */
export function isRoot() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
}

/**
 * Returns true if the current process holds the privileges required to open
 * and configure a TUN device on the host platform (root on POSIX,
 * Administrator on Windows).
 */
export async function hasPrivileges() {
  return process.platform === 'win32' ? await isAdministrator() : isRoot();
}
