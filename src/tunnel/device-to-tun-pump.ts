import type {Socket} from 'node:net';
import {Buffer} from 'node:buffer';

import type {TunTap} from '../TunTap.js';
import {appendBuffer} from './buffer-utils.js';
import {fwdDebug} from './forward-debug.js';
import {
  IPV6_HEADER_SIZE,
  IPV6_VERSION,
  MAX_DEVICE_INGRESS_BUFFER,
  DEVICE_PUMP_YIELD_EVERY_FRAMES,
} from './constants.js';

export type DeviceToTunProgressHook = () => void;

/**
 * Device→TUN forwarding: read one exact IPv6 frame from the socket, write to TUN,
 * repeat. Yields only when TUN write blocks (via notifyTunWritable from the TUN→device pump).
 */
export class DeviceToTunPump {
  private cancelled = false;
  private running = false;
  private buffer: Buffer = Buffer.alloc(0);
  private frameWaiter: ((packet: Buffer) => void) | null = null;
  private frameReject: ((err: Error) => void) | null = null;
  private tunWritableWaiter: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private fwdFrames = 0;
  private deviceIngressPaused = false;
  private deviceConn: Socket | null = null;
  private pendingDeviceChunks: Buffer[] = [];
  private deviceDrainScheduled = false;

  constructor(private readonly onFrameWritten?: DeviceToTunProgressHook) {}

  start(deviceConn: Socket, tun: TunTap): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.deviceConn = deviceConn;

    deviceConn.on('data', (chunk: Buffer) => this.enqueueDeviceData(chunk));

    fwdDebug('device-pump-start', {});
    this.loopPromise = this.runLoop(deviceConn, tun);
  }

  notifyTunWritable(): void {
    const waiter = this.tunWritableWaiter;
    if (waiter) {
      this.tunWritableWaiter = null;
      waiter();
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.frameReject) {
      this.frameReject(new Error(DEVICE_PUMP_CANCELLED));
    }
    if (this.tunWritableWaiter) {
      this.tunWritableWaiter();
    }
    this.frameWaiter = null;
    this.frameReject = null;
    this.tunWritableWaiter = null;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    this.buffer = Buffer.alloc(0);
    this.deviceConn = null;
    this.running = false;
  }

  private enqueueDeviceData(chunk: Buffer): void {
    if (this.cancelled || chunk.length === 0) {
      return;
    }
    this.pendingDeviceChunks.push(chunk);
    if (this.deviceDrainScheduled) {
      return;
    }
    this.deviceDrainScheduled = true;
    setImmediate(() => {
      this.deviceDrainScheduled = false;
      const chunks = this.pendingDeviceChunks;
      this.pendingDeviceChunks = [];
      for (const pending of chunks) {
        this.onDeviceData(pending);
      }
    });
  }

  private onDeviceData(chunk: Buffer): void {
    if (this.cancelled || chunk.length === 0) {
      return;
    }
    this.buffer = appendBuffer(this.buffer, chunk);
    if (
      this.deviceConn &&
      this.buffer.length > MAX_DEVICE_INGRESS_BUFFER &&
      !this.deviceIngressPaused
    ) {
      this.pauseDeviceIngress(this.deviceConn, 'max-buffer');
    }
    this.tryDeliverFrame();
  }

  private maybeResumeDeviceIngress(): void {
    if (
      !this.deviceConn ||
      !this.deviceIngressPaused ||
      this.buffer.length > MAX_DEVICE_INGRESS_BUFFER
    ) {
      return;
    }
    this.resumeDeviceIngress(this.deviceConn);
  }

  private tryDeliverFrame(): void {
    const waiter = this.frameWaiter;
    if (!waiter) {
      return;
    }

    const taken = takeOneIpv6Frame(this.buffer);
    if (taken.kind === 'incomplete' || taken.kind === 'resync') {
      if (taken.kind === 'resync') {
        this.buffer = this.buffer.subarray(1);
        this.tryDeliverFrame();
      }
      return;
    }

    this.buffer = shrinkBuffer(this.buffer, taken.length);
    this.frameWaiter = null;
    this.frameReject = null;
    waiter(taken.packet);
    this.maybeResumeDeviceIngress();
  }

  private readOneFrame(): Promise<Buffer> {
    if (this.cancelled) {
      return Promise.reject(new Error(DEVICE_PUMP_CANCELLED));
    }

    const taken = takeOneIpv6Frame(this.buffer);
    if (taken.kind === 'frame') {
      this.buffer = shrinkBuffer(this.buffer, taken.length);
      return Promise.resolve(taken.packet);
    }
    if (taken.kind === 'resync') {
      this.buffer = this.buffer.subarray(1);
      return this.readOneFrame();
    }

    return new Promise((resolve, reject) => {
      this.frameWaiter = resolve;
      this.frameReject = reject;
    });
  }

  private pauseDeviceIngress(deviceConn: Socket, reason: string): void {
    if (this.deviceIngressPaused || deviceConn.destroyed) {
      return;
    }
    this.deviceIngressPaused = true;
    deviceConn.pause();
    fwdDebug('ingress-pause', {reason, buf: this.buffer.length});
  }

  private resumeDeviceIngress(deviceConn: Socket): void {
    if (!this.deviceIngressPaused || deviceConn.destroyed) {
      return;
    }
    this.deviceIngressPaused = false;
    deviceConn.resume();
    fwdDebug('ingress-resume', {buf: this.buffer.length});
  }

  private waitTunWritable(): Promise<void> {
    if (this.cancelled) {
      return Promise.reject(new Error(DEVICE_PUMP_CANCELLED));
    }
    return new Promise((resolve) => {
      this.tunWritableWaiter = resolve;
    });
  }

  private async writeFrameToTun(deviceConn: Socket, tun: TunTap, packet: Buffer): Promise<void> {
    while (!this.cancelled) {
      const bytesWritten = tun.write(packet);
      if (bytesWritten > 0) {
        this.maybeResumeDeviceIngress();
        return;
      }
      // Block on tun.write() without pausing the TLS stream — keep reading into the
      // reassembly buffer while waiting for TUN→device progress to free utun capacity.
      fwdDebug('tun-write-blocked', {frameLen: packet.length, buf: this.buffer.length});
      await this.waitTunWritable();
    }
  }

  private async runLoop(deviceConn: Socket, tun: TunTap): Promise<void> {
    try {
      while (!this.cancelled && !deviceConn.destroyed) {
        const packet = await this.readOneFrame();
        if (this.cancelled) {
          break;
        }
        await this.writeFrameToTun(deviceConn, tun, packet);
        this.fwdFrames += 1;
        if (this.fwdFrames === 1 || this.fwdFrames % 200 === 0) {
          fwdDebug('device-pump-write', {len: packet.length, frames: this.fwdFrames});
        }
        this.onFrameWritten?.();
        if (this.fwdFrames % DEVICE_PUMP_YIELD_EVERY_FRAMES === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    } catch (err) {
      if (!isPumpCancelled(err)) {
        throw err;
      }
    }
    fwdDebug('device-pump-stop', {frames: this.fwdFrames});
  }
}

const DEVICE_PUMP_CANCELLED = 'device pump cancelled';

function isPumpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === DEVICE_PUMP_CANCELLED;
}

function takeOneIpv6Frame(
  buffer: Buffer,
): {kind: 'frame'; packet: Buffer; length: number} | {kind: 'incomplete'} | {kind: 'resync'} {
  if (buffer.length < IPV6_HEADER_SIZE) {
    return {kind: 'incomplete'};
  }

  const version = (buffer[0] >> 4) & 0x0f;
  if (version !== IPV6_VERSION) {
    return {kind: 'resync'};
  }

  const payloadLength = buffer.readUInt16BE(4);
  const length = IPV6_HEADER_SIZE + payloadLength;
  if (buffer.length < length) {
    return {kind: 'incomplete'};
  }

  return {
    kind: 'frame',
    packet: buffer.subarray(0, length),
    length,
  };
}

function shrinkBuffer(buffer: Buffer, consumed: number): Buffer {
  if (consumed >= buffer.length) {
    return Buffer.alloc(0);
  }
  return buffer.subarray(consumed);
}
