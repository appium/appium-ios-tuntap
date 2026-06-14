import {log} from '../logger.js';
import {TunTap} from '../TunTap.js';
import type {Socket} from 'node:net';

import {CD_TUNNEL_MTU} from './constants.js';
import {tunDebug} from './debug-log.js';
import {
  TunnelForwarder,
  type TunnelLockdownTlsCredentials,
  type TunnelPskTlsCredentials,
} from './forwarder.js';
import type {TunnelConnection, TunnelInfo} from './types.js';

/**
 * Manages a {@link TunTap} interface and native OpenSSL tunnel forwarding.
 */
export class TunnelManager {
  private tun: TunTap | null = null;
  private cancelled: boolean = false;
  private cleanupPromise: Promise<void> | null = null;
  private forwarder: TunnelForwarder | null = null;

  /**
   * Open a {@link TunTap}, assign the client IPv6 address/MTU, and add a /128 route to the server.
   *
   * @param tunnelInfo — handshake result (client address, MTU, server address)
   * @returns interface name, MTU, and the live {@link TunTap} instance
   */
  async setupInterface(
    tunnelInfo: TunnelInfo,
  ): Promise<{name: string; mtu: number; interface: TunTap}> {
    tunDebug(`Setting up tunnel with parameters:`, tunnelInfo);

    try {
      this.tun = new TunTap();

      if (!this.tun.open()) {
        throw new Error('Failed to open TUN device');
      }

      tunDebug(`Opened TUN device: ${this.tun.name}`);

      await this.tun.configure(
        tunnelInfo.clientParameters.address,
        tunnelInfo.clientParameters.mtu,
      );

      await this.tun.addRoute(`${tunnelInfo.serverAddress}/128`);

      tunDebug(
        `Configured TUN interface ${this.tun.name} with address ${tunnelInfo.clientParameters.address} and MTU ${tunnelInfo.clientParameters.mtu}`,
      );

      return {
        name: this.tun.name,
        mtu: tunnelInfo.clientParameters.mtu,
        interface: this.tun,
      };
    } catch (err: any) {
      log.error(`Error setting up TUN interface: ${err.message}`);
      if (this.tun) {
        try {
          this.tun.close();
        } catch (closeErr) {
          log.error('Error closing TUN device:', closeErr);
        }
        this.tun = null;
      }
      throw err;
    }
  }

  /**
   * Begin bidirectional forwarding via the OpenSSL native forwarder.
   *
   * @param forwarder — connected forwarder after {@link TunnelForwarder.handshake}
   * @param onDead — optional callback when native forwarder threads exit unexpectedly
   */
  startForwarding(forwarder: TunnelForwarder, onDead?: (reason: string) => void): void {
    if (!this.tun) {
      log.error('TUN device is not set up');
      return;
    }

    tunDebug(`Starting OpenSSL tunnel forwarding for ${this.tun.name}`);
    this.forwarder = forwarder;
    forwarder.startForwarding(this.tun.fd, (message) => {
      log.error('Tunnel forwarder error:', message);
      setImmediate(() => {
        void this.stop().then(() => {
          onDead?.(message);
        });
      });
    });
  }

  /**
   * Idempotent shutdown: stop forwarder and close the TUN device.
   *
   * @returns the same promise if already stopping/stopped
   */
  async stop(): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = this._performStop();
    return this.cleanupPromise;
  }

  private async _performStop(): Promise<void> {
    const tunName = this.tun ? this.tun.name : 'unknown';
    tunDebug(`Stopping tunnel manager for ${tunName}`);

    this.cancelled = true;

    // Close TUN first so native forwarder threads unblock on read/write.
    if (this.tun) {
      try {
        this.tun.close();
      } catch (err) {
        log.error('Error closing TUN device:', err);
      }
      this.tun = null;
    }

    if (this.forwarder) {
      this.forwarder.stop();
      this.forwarder = null;
    }

    tunDebug(`Tunnel for ${tunName} closed successfully`);
  }
}

async function connectTunnel(
  tcpSocket: Socket,
  setupTls: (forwarder: TunnelForwarder) => void,
  onDead?: (reason: string) => void,
): Promise<TunnelConnection> {
  if (process.platform === 'win32') {
    throw new Error('Native OpenSSL tunnel forwarder is not supported on Windows');
  }

  const tunnelManager = new TunnelManager();
  const forwarder = new TunnelForwarder();

  try {
    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 1000);

    setupTls(forwarder);
    const tunnelInfo = forwarder.handshake(CD_TUNNEL_MTU);
    tunDebug('Tunnel parameters exchanged:', tunnelInfo);

    const tunInterfaceInfo = await tunnelManager.setupInterface(tunnelInfo);
    tunDebug('Tunnel interface set up:', tunInterfaceInfo.name);

    tunnelManager.startForwarding(forwarder, onDead);

    const closeFunc = async () => {
      tunDebug('Closing tunnel connection');
      await tunnelManager.stop();
    };

    return {
      Address: tunnelInfo.serverAddress,
      RsdPort: tunnelInfo.serverRSDPort,
      tunnelManager,
      closer: closeFunc,
    };
  } catch (err: any) {
    log.error('Failed to connect to tunnel:', err);
    forwarder.stop();
    await tunnelManager.stop();
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
    throw err;
  }
}

/**
 * End-to-end setup with native OpenSSL forwarding over lockdown client-cert TLS.
 *
 * Pass a **plain TCP** CoreDeviceProxy socket and lockdown host cert/key PEM — do not
 * upgrade to Node `TLSSocket` first.
 */
export async function connectToTunnelLockdown(
  tcpSocket: Socket,
  credentials: TunnelLockdownTlsCredentials,
  options?: {onDead?: (reason: string) => void},
): Promise<TunnelConnection> {
  return connectTunnel(
    tcpSocket,
    (forwarder) => {
      forwarder.connect(tcpSocket, credentials);
    },
    options?.onDead,
  );
}

/**
 * End-to-end setup with native OpenSSL TLS-PSK forwarding (Apple TV Remote Pairing).
 *
 * Pass a **plain TCP** socket to the device listener port and the pair-verify encryption key.
 */
export async function connectToTunnelPsk(
  tcpSocket: Socket,
  credentials: TunnelPskTlsCredentials,
  options?: {onDead?: (reason: string) => void},
): Promise<TunnelConnection> {
  return connectTunnel(
    tcpSocket,
    (forwarder) => {
      forwarder.connectPsk(tcpSocket, credentials);
    },
    options?.onDead,
  );
}
