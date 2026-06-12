import {log} from '../logger.js';

/** Wedge diagnostics — set TUNTAP_DEBUG_FORWARD=1 on the tunnel process. */
export const TUNTAP_FORWARD_DEBUG =
  process.env.TUNTAP_DEBUG_FORWARD === '1' ||
  process.env.TUNTAP_DEBUG_FORWARD === 'true';

let seq = 0;

export function fwdDebug(
  event: string,
  detail?: Record<string, string | number | boolean>,
): void {
  if (!TUNTAP_FORWARD_DEBUG) {
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
