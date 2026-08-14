import {log} from '../logger.js';

/** Tunnel debug logging — set APPIUM_TUNTAP_DEBUG=1 on the tunnel process. */
export const APPIUM_TUNTAP_DEBUG =
  process.env.APPIUM_TUNTAP_DEBUG === '1' || process.env.APPIUM_TUNTAP_DEBUG === 'true';

/** {@link log.debug} when {@link APPIUM_TUNTAP_DEBUG} is enabled. */
export function tunDebug(...args: Parameters<typeof log.debug>): void {
  if (!APPIUM_TUNTAP_DEBUG) {
    return;
  }
  log.debug(...args);
}
