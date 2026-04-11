import { TunTapPermissionError } from '../errors.js';

/**
 * Ensures the process has effective superuser privileges (EUID 0).
 * Privileged `ip` / `ifconfig` / `route` calls are executed directly — no `sudo` subprocess.
 */
export function assertEffectiveRoot(): void {
    const geteuid = process.geteuid;
    if (typeof geteuid !== 'function' || geteuid.call(process) !== 0) {
        throw new TunTapPermissionError(
            'TUN interface configuration and routing require root privileges (effective UID 0)',
        );
    }
}
