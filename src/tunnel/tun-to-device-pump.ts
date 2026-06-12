import {once} from 'node:events';
import type {Socket} from 'node:net';

import type {TunTap} from '../TunTap.js';
import {MAX_TUN_INGRESS_QUEUE, TUN_POLL_TSFN_QUEUE_DEPTH} from './constants.js';
import {fwdDebug} from './forward-debug.js';

export type TunToDeviceProgressHook = () => void;

/**
 * pymobiledevice3-style TUN→device forwarding: read one packet, write, await
 * drain when the socket needs it, then read the next.
 */
export class TunToDevicePump {
  private cancelled = false;
  private running = false;
  private tunIngressQueue: Buffer[] = [];
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
      TUN_POLL_TSFN_QUEUE_DEPTH,
    );
    this.tun.pausePolling();

    fwdDebug('pump-start', {mtu: this.mtu, queueDepth: TUN_POLL_TSFN_QUEUE_DEPTH});
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
    this.tunIngressQueue = [];
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

    this.onPacketRead?.(data);
    this.tunIngressQueue.push(data);
    if (this.tunIngressQueue.length >= MAX_TUN_INGRESS_QUEUE) {
      this.tun.pausePolling();
      fwdDebug('tun-ingress-pause', {queued: this.tunIngressQueue.length});
    }
    this.deliverTunPacket();
  }

  private deliverTunPacket(): void {
    const waiter = this.tunPacketWaiter;
    if (!waiter || this.tunIngressQueue.length === 0) {
      return;
    }

    this.tunPacketWaiter = null;
    this.readReject = null;
    waiter(this.tunIngressQueue.shift()!);
    this.maybeResumeTunPolling();
  }

  private maybeResumeTunPolling(): void {
    if (this.tunIngressQueue.length < MAX_TUN_INGRESS_QUEUE) {
      this.tun.resumePolling();
    }
  }

  private readOnePacket(): Promise<Buffer> {
    if (this.cancelled) {
      return Promise.reject(new Error('pump cancelled'));
    }

    if (this.tunIngressQueue.length > 0) {
      const packet = this.tunIngressQueue.shift()!;
      this.maybeResumeTunPolling();
      return Promise.resolve(packet);
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
      // Unblock device→TUN while TLS send buffer drains (utun may accept writes again).
      this.onForwardProgress?.();
      fwdDebug('pump-drain-wait', {
        writableLength: deviceConn.writableLength,
        len: data.length,
        tunQueued: this.tunIngressQueue.length,
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
        tunQueued: this.tunIngressQueue.length,
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
        // Reading from utun may free kernel buffer for inbound utun writes.
        this.onForwardProgress?.();
        await this.writeAndDrain(deviceConn, packet);
      }
    } catch {
      // stop() rejected a pending readOnePacket()
    }
    fwdDebug('pump-stop', {packets: this.fwdPumpPackets});
  }
}
