/** CDTunnel lockdown handshake MTU (IPv6 minimum). */
export const CD_TUNNEL_MTU = 1280;
/** Upper bound for native TUN poll read size (matches N-API addon). */
export const MAX_TUN_POLL_BUFFER = 65_535;
/** Preferred poll read size when L4 packet tap is off. */
export const LARGE_TUN_POLL_BUFFER = 64 * 1024;
/** Default ThreadSafeFunction queue depth for TUN polling. */
export const DEFAULT_TUN_POLL_QUEUE_DEPTH = 8;
/** One in-flight TUN read for sequential pump forwarding. */
export const SEQUENTIAL_TUN_POLL_QUEUE_DEPTH = 1;
/** Max utun packets buffered between poll and TLS write (native poll may burst-read). */
export const MAX_TUN_INGRESS_QUEUE = 64;
/** ThreadSafeFunction queue depth for utun poll (must match ingress buffer). */
export const TUN_POLL_TSFN_QUEUE_DEPTH = MAX_TUN_INGRESS_QUEUE;

export const CD_TUNNEL_MAGIC = 'CDTunnel';
export const CD_TUNNEL_MAGIC_SIZE = 8;
export const CD_TUNNEL_HEADER_SIZE = CD_TUNNEL_MAGIC_SIZE + 2;
export const CD_TUNNEL_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Pause device ingress when the reassembly buffer exceeds this size. */
export const MAX_DEVICE_INGRESS_BUFFER = 8 * 1024 * 1024;

export const IPV6_HEADER_SIZE = 40;
export const IPV6_VERSION = 6;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
