import {TunTapPermissionError} from '../errors.js';
import {execFileAsync} from './exec.js';

let cached: boolean | null = null;

/**
 * Returns true when the current process is running with Administrator
 * privileges on Windows. Implementation runs `net session` (which always
 * exists, regardless of locale) and inspects the exit code.
 *
 * The result is cached for the lifetime of the process; admin status cannot
 * change between calls without restarting the shell.
 */
async function isAdministrator(): Promise<boolean> {
  if (cached !== null) {
    return cached;
  }

  try {
    await execFileAsync('net', ['session'], {windowsHide: true});
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * Throws {@link TunTapPermissionError} unless the current process is an
 * elevated (Administrator) Windows process. Mirrors `assertEffectiveRoot`
 * from {@link ./require-root.ts} for POSIX.
 */
export async function assertAdminOnWindows(): Promise<void> {
  if (await isAdministrator()) {
    return;
  }
  throw new TunTapPermissionError(
    'TUN interface configuration and routing require Administrator privileges on Windows. ' +
      'Re-launch the shell with "Run as administrator".',
  );
}
