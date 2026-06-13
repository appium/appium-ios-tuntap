import {log} from '../logger.js';

/** Tunnel debug logging — set APPIUM_TUNTAP_DEBUG=1 on the tunnel process. */
export const APPIUM_TUNTAP_DEBUG =
  process.env.APPIUM_TUNTAP_DEBUG === '1' || process.env.APPIUM_TUNTAP_DEBUG === 'true';

let seq = 0;

/** {@link log.debug} when {@link APPIUM_TUNTAP_DEBUG} is enabled. */
export function tunDebug(...args: Parameters<typeof log.debug>): void {
  if (!APPIUM_TUNTAP_DEBUG) {
    return;
  }
  log.debug(...args);
}

/** Log a numbered tunnel forward diagnostic when {@link APPIUM_TUNTAP_DEBUG} is enabled. */
export function fwdDebug(event: string, detail?: Record<string, string | number | boolean>): void {
  if (!APPIUM_TUNTAP_DEBUG) {
    return;
  }
  seq += 1;
  const parts = [`#${seq}`, event];
  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      parts.push(`${key}=${value}`);
    }
  }
  log.info(`[fwd] ${parts.join(' ')}`);
}

/** Summarize reassembly buffer state for debug logs. */
export function fwdBufferState(buffer: Buffer): {
  buf: number;
  tailKind: string;
} {
  if (buffer.length === 0) {
    return {buf: 0, tailKind: 'empty'};
  }
  if (buffer.length < 40) {
    return {buf: buffer.length, tailKind: 'short'};
  }
  const version = (buffer[0] >> 4) & 0x0f;
  if (version !== 6) {
    return {buf: buffer.length, tailKind: 'resync-needed'};
  }
  const payloadLength = buffer.readUInt16BE(4);
  const frameLength = 40 + payloadLength;
  if (buffer.length >= frameLength) {
    return {buf: buffer.length, tailKind: 'has-complete-frame'};
  }
  return {buf: buffer.length, tailKind: 'incomplete-tail'};
}
