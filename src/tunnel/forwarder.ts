import {createServer} from 'node:net';
import type {Server, Socket} from 'node:net';
import {createRequire} from 'node:module';

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
   * Windows has no stable way for native code to recover the OS socket from
   * an already-connected net.Socket: `_handle.fd` is hard-coded to -1 there
   * (libuv wraps an opaque SOCKET, not a POSIX fd), and reading V8's private
   * internal-object layout to find it isn't ABI-stable across V8 versions
   * (it broke a published build across a single Node upgrade).
   *
   * `tcpSocket` also can't simply be redialed by address: on Windows it's
   * typically the product of a one-time, stateful usbmux handshake (send a
   * "Connect" message, get an OK, then the *same* socket is repurposed in
   * place) rather than a plain listener that accepts fresh connections --
   * dialing its remoteAddress/remotePort again just opens a brand new,
   * unnegotiated session.
   *
   * So instead of extracting or redialing anything, bridge the already-
   * working `tcpSocket` through a local loopback TCP pair: pipe it into one
   * end, and let native code dial the other end itself via plain WinSock.
   * No Node/V8 internals are touched, and the already-negotiated session is
   * left completely alone.
   *
   * Because these pipes are pumped by the JS event loop, the native
   * connect/handshake calls that read through the bridge run on async
   * workers (promises), never synchronously on the JS thread.
   */
  private bridgeToNative(tcpSocket: Socket): Promise<{host: string; port: number}> {
    return new Promise((resolve, reject) => {
      const server = createServer((localSocket) => {
        // Only one bridge client (the native forwarder) is expected; stop
        // listening as soon as it arrives so the ephemeral port closes.
        server.close(() => {});
        localSocket.setNoDelay(true);
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
