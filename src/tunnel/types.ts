import type {TunnelManager} from './manager.js';

export interface TunnelConnection {
  Address: string;
  RsdPort?: number;
  tunnelManager: TunnelManager;
  /** Tear down the tunnel, close the TUN device, and end the socket when appropriate. */
  closer: () => Promise<void>;
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

export type CdTunnelParseResult =
  | {kind: 'incomplete'}
  | {kind: 'ok'; value: TunnelInfo}
  | {kind: 'error'; error: Error};
