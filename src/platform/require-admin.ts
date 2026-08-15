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

let confirmedAdmin = false;

/**
 * Returns true when the current process is running with Administrator
 * privileges on Windows, probed via `net session` exit code.
 *
 * Only success is cached: `net session` can fail transiently (spawn error,
 * 30s timeout) or permanently on Server-service-disabled machines, so a
 * failure is never cached and the next call re-probes.
 */
export async function isAdministrator(): Promise<boolean> {
  if (confirmedAdmin) {
    return true;
  }
  try {
    await execFileAsync('net', ['session'], {windowsHide: true});
    confirmedAdmin = true;
    return true;
  } catch {
    return false;
  }
}
