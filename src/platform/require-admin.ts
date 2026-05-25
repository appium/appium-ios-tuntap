import {util} from '@appium/support';

import {TunTapPermissionError} from '../errors.js';
import {execFileAsync} from './exec.js';

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

/**
 * Returns true when the current process is running with Administrator
 * privileges on Windows. Implementation runs `net session` (which always
 * exists, regardless of locale) and inspects the exit code.
 *
 * The result is memoized for the lifetime of the process; admin status cannot
 * change between calls without restarting the shell.
 */
const isAdministrator = util.memoize(async function isAdministratorUncached(): Promise<boolean> {
  try {
    await execFileAsync('net', ['session'], {windowsHide: true});
    return true;
  } catch {
    return false;
  }
});
