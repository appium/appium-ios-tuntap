/** CDTunnel lockdown handshake MTU (IPv6 minimum). */
export const CD_TUNNEL_MTU = 1280;
/** Upper bound for native TUN poll read size (matches N-API addon). */
export const MAX_TUN_POLL_BUFFER = 65_535;

export const CD_TUNNEL_MAGIC = 'CDTunnel';
export const CD_TUNNEL_MAGIC_SIZE = 8;
export const CD_TUNNEL_HEADER_SIZE = CD_TUNNEL_MAGIC_SIZE + 2;
export const CD_TUNNEL_HANDSHAKE_TIMEOUT_MS = 30_000;

export const IPV6_HEADER_SIZE = 40;
export const IPV6_VERSION = 6;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
