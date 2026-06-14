import {once} from 'node:events';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Socket} from 'node:net';

import {log} from '../logger.js';
import {MAX_TUN_EGRESS_QUEUE} from './constants.js';
import {fwdDebug} from './debug-log.js';

const require = createRequire(import.meta.url);
const pkgRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

interface NativeTunnelBridge {
  start(
    tunFd: number,
    mtu: number,
    onSocketWrite: (data: Buffer) => boolean,
    onError: (msg: string) => void,
  ): void;
  stop(): void;
  feedSocket(data: Buffer): void;
  notifySocketDrain(): void;
}

interface NativeTuntapModule {
  TunnelBridge: new () => NativeTunnelBridge;
}

/**
 * Native bidirectional tunnel forwarder (utun ↔ TLS socket) with IPv6 framing in C++.
 *
 * TUN poll + socket→TUN run in native code. tun→TLS uses a JS egress queue with async
 * drain handling — TLSSocket only emits `drain` once its writable buffer empties
 * (see node/lib/internal/streams/writable.js), which does not line up with sync writes
 * from an N-API callback. go-ios uses independent blocking goroutines per direction
 * (ios/tunnel/tunnel_lockdown.go).
 */
export class TunnelBridge {
  private bridge: NativeTunnelBridge | null = null;
  private socket: Socket | null = null;
  private onData: ((chunk: Buffer) => void) | null = null;
  private onDrain: (() => void) | null = null;
  private tunToSocketQueue: Buffer[] = [];
  private tunToSocketPump: Promise<void> | null = null;
  private drainAbort: AbortController | null = null;
  private writeCount = 0;

  start(deviceConn: Socket, tunFd: number, mtu: number): void {
    if (process.platform === 'win32') {
      throw new Error('Native tunnel bridge is not supported on Windows');
    }
    if (tunFd < 0) {
      throw new Error('TUN file descriptor is not available for native bridge');
    }

    const native = require('node-gyp-build')(pkgRoot) as NativeTuntapModule;
    this.bridge = new native.TunnelBridge();
    this.socket = deviceConn;

    this.onData = (chunk: Buffer) => {
      this.bridge?.feedSocket(chunk);
    };
    this.onDrain = () => {
      void this.runTunToSocketPump();
      this.bridge?.notifySocketDrain();
    };

    deviceConn.on('data', this.onData);
    deviceConn.on('drain', this.onDrain);

    this.bridge.start(
      tunFd,
      mtu,
      (data: Buffer) => this.enqueueTunPacket(data),
      (msg: string) => {
        log.error('Tunnel bridge error:', msg);
      },
    );

    fwdDebug('bridge-start', {mtu, tunFd});
  }

  async stop(): Promise<void> {
    this.drainAbort?.abort();
    this.drainAbort = null;
    this.tunToSocketQueue = [];
    if (this.tunToSocketPump) {
      await this.tunToSocketPump.catch(() => undefined);
      this.tunToSocketPump = null;
    }

    if (this.socket) {
      if (this.onData) {
        this.socket.removeListener('data', this.onData);
      }
      if (this.onDrain) {
        this.socket.removeListener('drain', this.onDrain);
      }
    }
    this.bridge?.stop();
    this.bridge = null;
    this.socket = null;
    this.onData = null;
    this.onDrain = null;
    this.writeCount = 0;
    fwdDebug('bridge-stop', {});
  }

  private enqueueTunPacket(data: Buffer): boolean {
    if (this.tunToSocketQueue.length >= MAX_TUN_EGRESS_QUEUE) {
      return false;
    }
    this.tunToSocketQueue.push(data);
    void this.runTunToSocketPump();
    return true;
  }

  private async runTunToSocketPump(): Promise<void> {
    if (this.tunToSocketPump) {
      return this.tunToSocketPump;
    }

    this.tunToSocketPump = this.drainTunToSocketQueue();
    try {
      await this.tunToSocketPump;
    } finally {
      this.tunToSocketPump = null;
      if (this.tunToSocketQueue.length > 0) {
        void this.runTunToSocketPump();
      }
    }
  }

  private async drainTunToSocketQueue(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return;
    }

    while (this.tunToSocketQueue.length > 0 && !socket.destroyed) {
      const packet = this.tunToSocketQueue.shift();
      if (!packet) {
        break;
      }
      await this.writePacketAndDrain(socket, packet);
    }
  }

  private async writePacketAndDrain(socket: Socket, packet: Buffer): Promise<void> {
    const canWriteMore = socket.write(packet);
    this.writeCount += 1;
    if (
      this.writeCount === 1 ||
      this.writeCount % 200 === 0 ||
      !canWriteMore ||
      socket.writableNeedDrain
    ) {
      fwdDebug('bridge-write', {
        len: packet.length,
        canWriteMore,
        needDrain: socket.writableNeedDrain,
        queued: this.tunToSocketQueue.length,
        packets: this.writeCount,
      });
    }

    if (!canWriteMore || socket.writableNeedDrain) {
      fwdDebug('bridge-drain-wait', {
        writableLength: socket.writableLength ?? 0,
        queued: this.tunToSocketQueue.length,
      });
      this.drainAbort = new AbortController();
      try {
        await once(socket, 'drain', {signal: this.drainAbort.signal});
      } catch {
        return;
      } finally {
        this.drainAbort = null;
      }
      fwdDebug('bridge-drain-done', {
        writableLength: socket.writableLength ?? 0,
        queued: this.tunToSocketQueue.length,
      });
    }

    this.bridge?.notifySocketDrain();
  }
}
