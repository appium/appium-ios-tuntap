import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Socket} from 'node:net';

import type {TunTap} from '../TunTap.js';
import type {TunnelInfo} from './types.js';

const require = createRequire(import.meta.url);
const pkgRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

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
  connectPsk(tcpFd: number, psk: Buffer, identity?: string): void;
  handshake(requestedMtu: number): TunnelInfo;
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

  connect(tcpSocket: Socket, credentials: TunnelLockdownTlsCredentials): void {
    const tcpFd = getSocketFd(tcpSocket);
    tcpSocket.pause();
    tcpSocket.removeAllListeners();

    const native = require('node-gyp-build')(pkgRoot) as NativeTuntapModule;
    this.forwarder = new native.TunnelForwarder();
    this.forwarder.connect(tcpFd, credentials.cert, credentials.key);

    this.takeSocketOwnership(tcpSocket);
  }

  connectPsk(tcpSocket: Socket, credentials: TunnelPskTlsCredentials): void {
    const tcpFd = getSocketFd(tcpSocket);
    tcpSocket.pause();
    tcpSocket.removeAllListeners();

    const native = require('node-gyp-build')(pkgRoot) as NativeTuntapModule;
    this.forwarder = new native.TunnelForwarder();
    this.forwarder.connectPsk(tcpFd, credentials.psk, credentials.identity ?? '');

    this.takeSocketOwnership(tcpSocket);
  }

  handshake(requestedMtu: number): TunnelInfo {
    if (!this.forwarder) {
      throw new Error('Tunnel forwarder is not connected');
    }
    return this.forwarder.handshake(requestedMtu);
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
    if (this.retainedSocket) {
      destroySocket(this.retainedSocket);
      this.retainedSocket = null;
    }
  }

  private takeSocketOwnership(socket: Socket): void {
    if (process.platform === 'win32') {
      this.retainedSocket = socket;
    } else {
      destroySocket(socket);
    }
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
