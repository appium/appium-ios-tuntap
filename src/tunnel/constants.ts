import {log} from '../logger.js';

/** CDTunnel lockdown handshake MTU (IPv6 minimum). */
export const CD_TUNNEL_MTU_SIZE = 1280;

/** Upper bound for MTU requests (WinTun per-packet cap is 65535; keep margin). */
export const MAX_TUNNEL_MTU_REQUEST_SIZE = 65000;

export const IPV6_HEADER_SIZE = 40;
export const IPV6_VERSION = 6;

let warnedInvalidValue: string | null = null;

/**
 * MTU to request in the CDTunnel handshake, from APPIUM_TUNTAP_MTU_REQUEST_SIZE.
 * Clamped to [CD_TUNNEL_MTU_SIZE, MAX_TUNNEL_MTU_REQUEST_SIZE]; unset or invalid
 * falls back to CD_TUNNEL_MTU_SIZE. The device may grant less than requested.
 * Not memoized on purpose: callers may change the env between tunnels; the
 * invalid-value warning is deduped instead so it logs once per distinct value.
 */
export function getRequestedTunnelMtu(): number {
  const raw = process.env.APPIUM_TUNTAP_MTU_REQUEST_SIZE?.trim();
  if (!raw) {
    return CD_TUNNEL_MTU_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    if (warnedInvalidValue !== raw) {
      warnedInvalidValue = raw;
      log.warn(`Ignoring invalid APPIUM_TUNTAP_MTU_REQUEST_SIZE '${raw}'; using default MTU ${CD_TUNNEL_MTU_SIZE}`);
    }
    return CD_TUNNEL_MTU_SIZE;
  }
  return Math.min(Math.max(parsed, CD_TUNNEL_MTU_SIZE), MAX_TUNNEL_MTU_REQUEST_SIZE);
}
