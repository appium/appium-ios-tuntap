import {log} from '../logger.js';

/** CDTunnel lockdown handshake MTU (IPv6 minimum). */
export const CD_TUNNEL_MTU = 1280;

/** Upper bound for MTU requests (WinTun per-packet cap is 65535; keep margin). */
export const MAX_TUNNEL_MTU_REQUEST = 65000;

export const IPV6_HEADER_SIZE = 40;
export const IPV6_VERSION = 6;

/**
 * MTU to request in the CDTunnel handshake, from APPIUM_TUNTAP_MTU_REQUEST.
 * Clamped to [CD_TUNNEL_MTU, MAX_TUNNEL_MTU_REQUEST]; unset or invalid falls
 * back to CD_TUNNEL_MTU. The device may grant less than requested.
 */
export function getRequestedTunnelMtu(): number {
  const raw = process.env.APPIUM_TUNTAP_MTU_REQUEST?.trim();
  if (!raw) {
    return CD_TUNNEL_MTU;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    log.warn(`Ignoring invalid APPIUM_TUNTAP_MTU_REQUEST '${raw}'; using default MTU ${CD_TUNNEL_MTU}`);
    return CD_TUNNEL_MTU;
  }
  return Math.min(Math.max(parsed, CD_TUNNEL_MTU), MAX_TUNNEL_MTU_REQUEST);
}
