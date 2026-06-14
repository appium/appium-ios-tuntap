import {log} from '../logger.js';
import {TunTap} from '../TunTap.js';
import type {Socket} from 'node:net';
import {Buffer} from 'node:buffer';

import {
  CD_TUNNEL_HANDSHAKE_TIMEOUT_MS,
  CD_TUNNEL_HEADER_SIZE,
  CD_TUNNEL_MAGIC,
  CD_TUNNEL_MAGIC_SIZE,
  CD_TUNNEL_MTU,
} from './constants.js';
import {appendBuffer} from './buffer-utils.js';
import {tunDebug} from './debug-log.js';
import {TunnelBridge} from './bridge.js';
import {TunnelForwarder, type TunnelLockdownTlsCredentials} from './forwarder.js';
import type {CdTunnelParseResult, TunnelConnection, TunnelInfo} from './types.js';

/**
 * Bridges a CoreDevice tunnel `Socket` and a {@link TunTap} interface via the native tunnel bridge.
 */
export class TunnelManager {
  private tun: TunTap | null = null;
  private cancelled: boolean = false;
  private mtu: number = CD_TUNNEL_MTU;
  private deviceConn: Socket | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private bridge: TunnelBridge | null = null;
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

      // Open the TUN device
      if (!this.tun.open()) {
        throw new Error('Failed to open TUN device');
      }

      tunDebug(`Opened TUN device: ${this.tun.name}`);

      this.mtu = tunnelInfo.clientParameters.mtu;

      // Configure the TUN device with IPv6 address and MTU
      await this.tun.configure(
        tunnelInfo.clientParameters.address,
        tunnelInfo.clientParameters.mtu,
      );

      // Add route for the server address
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
   * Begin bidirectional forwarding: device socket ↔ TUN (requires {@link TunnelManager.setupInterface} first).
   *
   * @param deviceConn — connected tunnel socket after the CDTunnel handshake
   */
  startForwarding(deviceConn: Socket): void {
    if (!this.tun) {
      log.error('TUN device is not set up');
      return;
    }

    this.deviceConn = deviceConn;
    tunDebug(`Starting bidirectional data forwarding for ${this.tun.name}`);

    deviceConn.setNoDelay(true);
    deviceConn.setKeepAlive(true, 1000);

    this.bridge = new TunnelBridge();
    this.bridge.start(deviceConn, this.tun.fd, this.mtu);

    // Listen for device connection close
    deviceConn.on('close', async () => {
      tunDebug('Device connection closed, stopping tunnel');
      try {
        await this.stop();
      } catch (err) {
        log.error('Error stopping tunnel: ', err);
      }
    });

    deviceConn.on('error', (err: Error) => {
      log.error('Device connection error: ', err);
    });
  }

  /**
   * Begin bidirectional forwarding via the OpenSSL native forwarder (raw TCP + host cert).
   *
   * @param forwarder — connected forwarder after {@link TunnelForwarder.handshake}
   */
  startNativeForwarding(forwarder: TunnelForwarder): void {
    if (!this.tun) {
      log.error('TUN device is not set up');
      return;
    }

    tunDebug(`Starting OpenSSL tunnel forwarding for ${this.tun.name}`);
    this.forwarder = forwarder;
    forwarder.startForwarding(this.tun.fd);
  }

  /**
   * Idempotent shutdown: stop bridge, destroy the socket, close the TUN device.
   *
   * @returns the same promise if already stopping/stopped
   */
  async stop(): Promise<void> {
    // Prevent multiple concurrent stops
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = this._performStop();
    return this.cleanupPromise;
  }

  private async _performStop(): Promise<void> {
    const tunName = this.tun ? this.tun.name : 'unknown';
    tunDebug(`Stopping tunnel manager for ${tunName}`);

    // Signal cancellation
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

    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }

    if (this.deviceConn && !this.deviceConn.destroyed) {
      this.deviceConn.destroy();
      this.deviceConn = null;
    }

    tunDebug(`Tunnel for ${tunName} closed successfully`);
  }
}

/**
 * Perform the CDTunnel JSON handshake (8-byte magic + length-prefixed JSON) over `socket`.
 *
 * @param socket — connected stream to the tunnel service
 * @returns parsed tunnel parameters from the device response
 */
export async function exchangeCoreTunnelParameters(socket: Socket): Promise<TunnelInfo> {
  const requestJson = JSON.stringify({
    type: 'clientHandshakeRequest',
    mtu: CD_TUNNEL_MTU,
  });
  const message = encodeCdTunnelMessage(requestJson);

  tunDebug(
    `Sending CDTunnel packet: magic=${CD_TUNNEL_MAGIC}, length=${message.length - CD_TUNNEL_HEADER_SIZE}, body=${requestJson}`,
  );

  socket.write(message);
  return readCdTunnelResponse(socket, CD_TUNNEL_HANDSHAKE_TIMEOUT_MS);
}

/**
 * End-to-end setup: handshake, TUN configuration, route, and forwarding on `secureServiceSocket`.
 *
 * @param secureServiceSocket — tunnel socket (e.g. from lockdown secure service)
 * @returns connection handle with {@link TunnelConnection.closer}
 */
export async function connectToTunnelLockdown(
  secureServiceSocket: Socket,
): Promise<TunnelConnection> {
  const tunnelManager = new TunnelManager();

  try {
    // Exchange tunnel parameters with the device
    const tunnelInfo = await exchangeCoreTunnelParameters(secureServiceSocket);
    tunDebug('Tunnel parameters exchanged:', tunnelInfo);

    // Setup tunnel interface
    const tunInterfaceInfo = await tunnelManager.setupInterface(tunnelInfo);
    tunDebug('Tunnel interface set up:', tunInterfaceInfo.name);

    // Start bidirectional forwarding
    tunnelManager.startForwarding(secureServiceSocket);

    // Create close function
    const closeFunc = async () => {
      tunDebug('Closing tunnel connection');
      await tunnelManager.stop();

      if (!secureServiceSocket.destroyed) {
        secureServiceSocket.end();
      }
    };

    return {
      Address: tunnelInfo.serverAddress,
      RsdPort: tunnelInfo.serverRSDPort,
      tunnelManager,
      closer: closeFunc,
    };
  } catch (err: any) {
    log.error('Failed to connect to tunnel:', err);
    await tunnelManager.stop();
    if (!secureServiceSocket.destroyed) {
      secureServiceSocket.end();
    }
    throw err;
  }
}

/**
 * End-to-end setup with native OpenSSL forwarding (pmd3/go-ios style pthread loops).
 *
 * Pass a **plain TCP** CoreDeviceProxy socket and lockdown host cert/key PEM — do not
 * upgrade to Node `TLSSocket` first.
 *
 * @param tcpSocket — connected usbmux TCP socket to CoreDeviceProxy
 * @param credentials — `HostCertificate` / `HostPrivateKey` from the pair record
 */
export async function connectToTunnelLockdownNative(
  tcpSocket: Socket,
  credentials: TunnelLockdownTlsCredentials,
): Promise<TunnelConnection> {
  if (process.platform === 'win32') {
    throw new Error('Native OpenSSL tunnel forwarder is not supported on Windows');
  }

  const tunnelManager = new TunnelManager();
  const forwarder = new TunnelForwarder();

  try {
    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 1000);

    forwarder.connect(tcpSocket, credentials);
    const tunnelInfo = forwarder.handshake(CD_TUNNEL_MTU);
    tunDebug('Tunnel parameters exchanged (native TLS):', tunnelInfo);

    const tunInterfaceInfo = await tunnelManager.setupInterface(tunnelInfo);
    tunDebug('Tunnel interface set up:', tunInterfaceInfo.name);

    tunnelManager.startNativeForwarding(forwarder);

    const closeFunc = async () => {
      tunDebug('Closing native tunnel connection');
      await tunnelManager.stop();
    };

    return {
      Address: tunnelInfo.serverAddress,
      RsdPort: tunnelInfo.serverRSDPort,
      tunnelManager,
      closer: closeFunc,
    };
  } catch (err: any) {
    log.error('Failed to connect to tunnel (native TLS):', err);
    forwarder.stop();
    await tunnelManager.stop();
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
    throw err;
  }
}

function encodeCdTunnelMessage(json: string): Buffer {
  const body = Buffer.from(json);
  const header = Buffer.alloc(CD_TUNNEL_HEADER_SIZE);
  header.write(CD_TUNNEL_MAGIC, 0, CD_TUNNEL_MAGIC_SIZE, 'ascii');
  header.writeUInt16BE(body.length, CD_TUNNEL_MAGIC_SIZE);
  return Buffer.concat([header, body]);
}

function tryParseCdTunnelResponse(buffer: Buffer): CdTunnelParseResult {
  if (buffer.length < CD_TUNNEL_HEADER_SIZE) {
    return {kind: 'incomplete'};
  }

  const magic = buffer.subarray(0, CD_TUNNEL_MAGIC_SIZE).toString();
  if (magic !== CD_TUNNEL_MAGIC) {
    log.error('Invalid magic header:', magic);
    return {kind: 'error', error: new Error('Invalid packet format')};
  }

  const payloadLength = buffer.readUInt16BE(CD_TUNNEL_MAGIC_SIZE);
  const totalLength = CD_TUNNEL_HEADER_SIZE + payloadLength;
  if (buffer.length < totalLength) {
    return {kind: 'incomplete'};
  }

  try {
    const value = JSON.parse(
      buffer.subarray(CD_TUNNEL_HEADER_SIZE, totalLength).toString(),
    ) as TunnelInfo;
    return {kind: 'ok', value};
  } catch (err) {
    log.error('Failed to parse JSON:', err);
    return {kind: 'error', error: new Error('Invalid JSON response')};
  }
}

function readCdTunnelResponse(socket: Socket, timeoutMs: number): Promise<TunnelInfo> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      clearTimeout(timeoutHandle);
    };

    const finish = (action: () => void) => {
      cleanup();
      action();
    };

    const onData = (chunk: Buffer) => {
      tunDebug('Received data chunk:', chunk.length, 'bytes');
      buffer = appendBuffer(buffer, chunk);

      if (buffer.length >= CD_TUNNEL_HEADER_SIZE) {
        const payloadLength = buffer.readUInt16BE(CD_TUNNEL_MAGIC_SIZE);
        tunDebug(
          'Expected total packet length:',
          CD_TUNNEL_HEADER_SIZE + payloadLength,
          'current buffer:',
          buffer.length,
        );
      }

      const result = tryParseCdTunnelResponse(buffer);
      if (result.kind === 'incomplete') {
        return;
      }
      if (result.kind === 'error') {
        finish(() => reject(result.error));
        return;
      }

      tunDebug('Parsed CDTunnel response:', result.value);
      finish(() => resolve(result.value));
    };

    const onError = (err: Error) => {
      log.error('Socket error:', err);
      finish(() => reject(err));
    };

    const onEnd = () => {
      tunDebug('Connection ended');
      if (buffer.length > 0) {
        tunDebug('Buffer at end:', buffer.toString('hex'));
      }
      finish(() => reject(new Error('Connection closed before receiving complete response')));
    };

    const timeoutHandle = setTimeout(() => {
      finish(() => reject(new Error('Tunnel handshake timeout')));
    }, timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}
