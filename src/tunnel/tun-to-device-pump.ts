import {once} from 'node:events';
import type {Socket} from 'node:net';

import type {TunTap} from '../TunTap.js';
import {MAX_TUN_INGRESS_QUEUE, TUN_POLL_TSFN_QUEUE_DEPTH} from './constants.js';
import {fwdDebug} from './debug-log.js';

export type TunToDeviceProgressHook = () => void;

/**
 * TUN→device forwarding: utun poll fills an ingress queue; a writer loop drains
 * the queue to TLS with backpressure (await drain).
 */
export class TunToDevicePump {
  private cancelled = false;
  private running = false;
  private tunIngressQueue: Buffer[] = [];
  private ingressWaiter: (() => void) | null = null;
  private ingressReject: ((err: Error) => void) | null = null;
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
    this.tun.resumePolling();

    fwdDebug('pump-start', {mtu: this.mtu, queueDepth: TUN_POLL_TSFN_QUEUE_DEPTH});
    this.loopPromise = this.runLoop(deviceConn);
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    this.drainAbort?.abort();
    this.drainAbort = null;
    this.tun.pausePolling();
    if (this.ingressReject) {
      this.ingressReject(new Error(TUN_PUMP_CANCELLED));
    } else if (this.ingressWaiter) {
      this.ingressWaiter();
    }
    this.ingressWaiter = null;
    this.ingressReject = null;
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
    this.signalIngress();
  }

  private signalIngress(): void {
    const waiter = this.ingressWaiter;
    if (!waiter) {
      return;
    }
    this.ingressWaiter = null;
    this.ingressReject = null;
    waiter();
  }

  private maybeResumeTunPolling(): void {
    if (this.tunIngressQueue.length < MAX_TUN_INGRESS_QUEUE) {
      this.tun.resumePolling();
    }
  }

  private waitForIngress(): Promise<void> {
    if (this.cancelled) {
      return Promise.reject(new Error(TUN_PUMP_CANCELLED));
    }
    if (this.tunIngressQueue.length > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.ingressWaiter = resolve;
      this.ingressReject = reject;
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
        await this.waitForIngress();
        while (this.tunIngressQueue.length > 0 && !this.cancelled && !deviceConn.destroyed) {
          const packet = this.tunIngressQueue.shift();
          if (!packet) {
            break;
          }
          this.maybeResumeTunPolling();
          this.fwdPumpPackets += 1;
          if (this.fwdPumpPackets === 1 || this.fwdPumpPackets % 200 === 0) {
            fwdDebug('pump-read', {len: packet.length, packets: this.fwdPumpPackets});
          }
          this.onForwardProgress?.();
          await this.writeAndDrain(deviceConn, packet);
        }
      }
    } catch (err) {
      if (!isPumpCancelled(err)) {
        throw err;
      }
    }
    fwdDebug('pump-stop', {packets: this.fwdPumpPackets});
  }
}

const TUN_PUMP_CANCELLED = 'pump cancelled';

function isPumpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === TUN_PUMP_CANCELLED;
}
