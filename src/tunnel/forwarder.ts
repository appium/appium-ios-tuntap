import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import type {Server, Socket} from 'node:net';

import {getPkgRoot} from '../pkg-root.js';
import type {TunTap} from '../TunTap.js';
import type {TunnelInfo} from './types.js';

const require = createRequire(import.meta.url);

/** PEM host certificate + private key from the usbmux pair record (lockdown TLS). */
export interface TunnelLockdownTlsCredentials {
  cert: string;
  key: string;
}

/** Pre-shared key from Apple TV Remote Pairing pair-verify (X25519 shared secret). */
export interface TunnelPskTlsCredentials {
  psk: Buffer;
  /** PSK identity sent to the device (Apple TV uses empty string). */
  identity?: string;
}

interface NativeTunnelForwarder {
  connect(tcpFd: number, certPem: string, keyPem: string): void;
  connectHost(host: string, port: number, certPem: string, keyPem: string): Promise<void>;
  connectPsk(tcpFd: number, psk: Buffer, identity?: string): void;
  connectPskHost(host: string, port: number, psk: Buffer, identity?: string): Promise<void>;
  handshake(requestedMtu: number): Promise<TunnelInfo>;
  startForwarding(tunForwardingHandle: unknown, onError?: (message: string) => void): void;
  stop(): void;
}

interface NativeTuntapModule {
  TunnelForwarder: new () => NativeTunnelForwarder;
}

/**
 * OpenSSL tunnel forwarder (pmd3/go-ios style): TLS + two blocking pthread loops in C++.
 */
export class TunnelForwarder {
  private forwarder: NativeTunnelForwarder | null = null;
  private retainedSocket: Socket | null = null;
  private loopbackBridge: Server | null = null;

  async connect(tcpSocket: Socket, credentials: TunnelLockdownTlsCredentials): Promise<void> {
    const native = require('node-gyp-build')(getPkgRoot()) as NativeTuntapModule;
    this.forwarder = new native.TunnelForwarder();

    if (process.platform === 'win32') {
      const {host, port} = await this.bridgeToNative(tcpSocket);
      await this.forwarder.connectHost(host, port, credentials.cert, credentials.key);
    } else {
      tcpSocket.pause();
      tcpSocket.removeAllListeners();
      this.forwarder.connect(getSocketFd(tcpSocket), credentials.cert, credentials.key);
      this.takeSocketOwnership(tcpSocket);
    }
  }

  async connectPsk(tcpSocket: Socket, credentials: TunnelPskTlsCredentials): Promise<void> {
    const native = require('node-gyp-build')(getPkgRoot()) as NativeTuntapModule;
    this.forwarder = new native.TunnelForwarder();

    if (process.platform === 'win32') {
      const {host, port} = await this.bridgeToNative(tcpSocket);
      await this.forwarder.connectPskHost(host, port, credentials.psk, credentials.identity ?? '');
    } else {
      tcpSocket.pause();
      tcpSocket.removeAllListeners();
      this.forwarder.connectPsk(getSocketFd(tcpSocket), credentials.psk, credentials.identity ?? '');
      this.takeSocketOwnership(tcpSocket);
    }
  }

  async handshake(requestedMtu: number): Promise<TunnelInfo> {
    if (!this.forwarder) {
      throw new Error('Tunnel forwarder is not connected');
    }
    return await this.forwarder.handshake(requestedMtu);
  }

  startForwarding(tun: TunTap, onError?: (message: string) => void): void {
    if (!this.forwarder) {
      throw new Error('Tunnel forwarder is not connected');
    }
    const forwardingHandle = tun.forwardingHandle;
    if (onError) {
      this.forwarder.startForwarding(forwardingHandle, onError);
    } else {
      this.forwarder.startForwarding(forwardingHandle);
    }
  }

  stop(): void {
    this.forwarder?.stop();
    this.forwarder = null;
    if (this.loopbackBridge) {
      // May already be closed (the listener shuts down after the first
      // accept); the callback form swallows ERR_SERVER_NOT_RUNNING.
      this.loopbackBridge.close(() => {});
      this.loopbackBridge = null;
    }
    if (this.retainedSocket) {
      destroySocket(this.retainedSocket);
      this.retainedSocket = null;
    }
  }

  private takeSocketOwnership(socket: Socket): void {
    destroySocket(socket);
  }

  /**
   * Bridges an already-connected `tcpSocket` to native code through a local
   * loopback TCP pair, so native dials the bridge instead of touching the
   * original socket.
   *
   * Windows can't hand the OS socket to native (`_handle.fd` is -1, and
   * reading V8 internals to find it broke a prebuild across a Node upgrade),
   * and the socket can't be redialed either -- it's the product of a
   * one-time usbmux handshake, so a fresh dial gets an unnegotiated session.
   *
   * Costs roughly half the throughput of a direct fd handoff, since every
   * byte crosses two extra user/kernel boundaries with the JS event loop as
   * the pump. Accepted deliberately: slower but stable.
   *
   * Only a real device exercises this. To verify changes, link into
   * appium-ios-remotexpc and run `test:afc-tunnel-stability` with
   * AFC_STABILITY_ITERATIONS=20; what matters is flatness, not absolute
   * speed -- degrading later rounds mean the bridge isn't draining.
   */
  private bridgeToNative(tcpSocket: Socket): Promise<{host: string; port: number}> {
    return new Promise((resolve, reject) => {
      const server = createServer((localSocket) => {
        // Only one bridge client (the native forwarder) is expected; stop
        // listening as soon as it arrives so the ephemeral port closes.
        server.close(() => {});
        localSocket.setNoDelay(true);
        // Mirrors the device socket's settings; on loopback this is mostly
        // defensive, since a dead peer already surfaces as close/error.
        localSocket.setKeepAlive(true, 1000);
        tcpSocket.pipe(localSocket);
        localSocket.pipe(tcpSocket);

        const teardown = () => {
          destroySocket(localSocket);
          destroySocket(tcpSocket);
        };
        localSocket.on('error', teardown);
        localSocket.on('close', teardown);
        tcpSocket.on('error', teardown);
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address !== 'object') {
          reject(new Error('Failed to determine loopback bridge port'));
          return;
        }
        this.loopbackBridge = server;
        this.retainedSocket = tcpSocket;
        resolve({host: '127.0.0.1', port: address.port});
      });
    });
  }
}

function getSocketFd(socket: Socket): number {
  const handle = (socket as {_handle?: {fd?: number}})._handle;
  if (typeof handle?.fd === 'number' && handle.fd >= 0) {
    return handle.fd;
  }
  throw new Error('TCP socket file descriptor is not available');
}

function destroySocket(socket: Socket): void {
  if (!socket.destroyed) {
    socket.destroy();
  }
}
