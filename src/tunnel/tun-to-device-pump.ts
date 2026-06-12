import {once} from 'node:events';
import type {Socket} from 'node:net';

import type {TunTap} from '../TunTap.js';
import {SEQUENTIAL_TUN_POLL_QUEUE_DEPTH} from './constants.js';
import {fwdDebug} from './forward-debug.js';

export type TunToDeviceProgressHook = () => void;

/**
 * pymobiledevice3-style TUN→device forwarding: read one packet, write, await
 * drain when the socket needs it, then read the next.
 */
export class TunToDevicePump {
  private cancelled = false;
  private running = false;
  private tunPacketWaiter: ((packet: Buffer) => void) | null = null;
  private readReject: ((err: Error) => void) | null = null;
  private drainAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private fwdPumpPackets = 0;

  constructor(
    private readonly tun: TunTap,
    private readonly mtu: number,
    private readonly onPacketRead?: (data: Buffer) => void,
    private readonly onForwardProgress?: TunToDeviceProgressHook,
  ) {}

  start(deviceConn: Socket): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;

    this.tun.startPolling(
      (data: Buffer) => this.onTunPollData(data),
      this.mtu,
      SEQUENTIAL_TUN_POLL_QUEUE_DEPTH,
    );
    this.tun.pausePolling();

    fwdDebug('pump-start', {mtu: this.mtu, queueDepth: SEQUENTIAL_TUN_POLL_QUEUE_DEPTH});
    this.loopPromise = this.runLoop(deviceConn);
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    this.drainAbort?.abort();
    this.drainAbort = null;
    this.tun.pausePolling();
    if (this.readReject) {
      this.readReject(new Error('pump cancelled'));
      this.readReject = null;
    }
    this.tunPacketWaiter = null;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    this.running = false;
  }

  private onTunPollData(data: Buffer): void {
    if (this.cancelled || !data.length) {
      return;
    }

    this.tun.pausePolling();
    this.onPacketRead?.(data);

    const waiter = this.tunPacketWaiter;
    if (waiter) {
      this.tunPacketWaiter = null;
      this.readReject = null;
      waiter(data);
    }
  }

  private readOnePacket(): Promise<Buffer> {
    if (this.cancelled) {
      return Promise.reject(new Error('pump cancelled'));
    }
    return new Promise((resolve, reject) => {
      this.tunPacketWaiter = resolve;
      this.readReject = reject;
      this.tun.resumePolling();
    });
  }

  private async writeAndDrain(deviceConn: Socket, data: Buffer): Promise<void> {
    if (deviceConn.destroyed) {
      return;
    }

    const canWriteMore = deviceConn.write(data);
    if (this.fwdPumpPackets === 1 || this.fwdPumpPackets % 200 === 0 || !canWriteMore) {
      fwdDebug('pump-write', {
        len: data.length,
        canWriteMore,
        writableLength: deviceConn.writableLength,
        packets: this.fwdPumpPackets,
      });
    }
    if (!canWriteMore || deviceConn.writableNeedDrain) {
      fwdDebug('pump-drain-wait', {
        writableLength: deviceConn.writableLength,
        len: data.length,
      });
      this.drainAbort = new AbortController();
      try {
        await once(deviceConn, 'drain', {signal: this.drainAbort.signal});
      } catch {
        return;
      } finally {
        this.drainAbort = null;
      }
      fwdDebug('pump-drain-done', {
        writableLength: deviceConn.writableLength,
      });
    }
    if (this.cancelled) {
      return;
    }
    this.onForwardProgress?.();
  }

  private async runLoop(deviceConn: Socket): Promise<void> {
    try {
      while (!this.cancelled && !deviceConn.destroyed) {
        const packet = await this.readOnePacket();
        if (this.cancelled) {
          break;
        }
        this.fwdPumpPackets += 1;
        if (this.fwdPumpPackets === 1 || this.fwdPumpPackets % 200 === 0) {
          fwdDebug('pump-read', {len: packet.length, packets: this.fwdPumpPackets});
        }
        await this.writeAndDrain(deviceConn, packet);
      }
    } catch {
      // stop() rejected a pending readOnePacket()
    }
    fwdDebug('pump-stop', {packets: this.fwdPumpPackets});
  }
}
