import type {Buffer} from 'node:buffer';

import type {TunnelManager} from './manager.js';

export interface PacketData {
  protocol: 'TCP' | 'UDP';
  src: string;
  dst: string;
  sourcePort: number;
  destPort: number;
  payload: Buffer;
}

/**
 * Event names and listener argument tuples for {@link TunnelManager}
 * (matches Node’s `EventEmitter` event map shape).
 *
 * @example
 * tunnelManager.on('data', (packet) => {
 *   // `packet` is PacketData
 * });
 */
export interface PacketConsumer {
  /**
   * Invoked for each parsed TCP/UDP payload extracted from the tunnel stream.
   *
   * @param packet — decoded addresses, ports, and payload
   */
  onPacket(packet: PacketData): void;
}

export interface TunnelManagerEvents {
  data: [packet: PacketData];
}

export interface TunnelConnection {
  Address: string;
  RsdPort?: number;
  tunnelManager: TunnelManager;
  /** Tear down the tunnel, close the TUN device, and end the socket when appropriate. */
  closer: () => Promise<void>;
  /** @param consumer — receives packets for the lifetime of the registration */
  addPacketConsumer(consumer: PacketConsumer): void;
  /** @param consumer — must be the same reference passed to {@link TunnelConnection.addPacketConsumer} */
  removePacketConsumer(consumer: PacketConsumer): void;
  /** @returns async iterator of packets until the tunnel is stopped */
  getPacketStream(): AsyncIterable<PacketData>;
}

export interface TunnelClientParameters {
  address: string;
  mtu: number;
}

export interface TunnelInfo {
  clientParameters: TunnelClientParameters;
  serverAddress: string;
  serverRSDPort?: number;
}

export type Ipv6Frame =
  | {kind: 'frame'; packet: Buffer; nextHeader: number; length: number}
  | {kind: 'incomplete'}
  | {kind: 'resync'};

export type CdTunnelParseResult =
  | {kind: 'incomplete'}
  | {kind: 'ok'; value: TunnelInfo}
  | {kind: 'error'; error: Error};
