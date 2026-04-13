import {createRequire} from 'node:module';
import {isIPv6} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {TunTapDeviceError, TunTapError, TunTapPermissionError} from './errors.js';
import {log} from './logger.js';
import {createTunTapPlatform} from './platform/create-platform.js';
import type {TunTapInterfaceStats, TunTapPlatform} from './platform/types.js';

const require = createRequire(import.meta.url);
/** Package root (contains binding.gyp, prebuilds/, or build/ after compile). */
const pkgRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_READ_BUFFER_SIZE = 4096;
const MAX_BUFFER_SIZE = 0xffff; // 65535
const DEFAULT_MTU = 1500;
const MIN_MTU = 1280;

/**
 * Called by {@link TunTap.startPolling} for each packet read from the TUN device.
 *
 * @param data — raw L3 frame (IPv6) read from the device
 */
export type PacketCallback = (data: Buffer) => void;

interface NativeTunDevice {
  open(): boolean;
  close(): void;
  read(maxSize: number): Buffer;
  write(data: Buffer): number;
  getName(): string;
  getFd(): number;
  startPolling(callback: PacketCallback, bufferSize?: number): void;
}

interface NativeTuntapModule {
  TunDevice: new (name?: string) => NativeTunDevice;
}

const nativeTuntap = require('node-gyp-build')(pkgRoot) as NativeTuntapModule;

/**
 * Validates an IPv6 route destination (address with optional CIDR prefix).
 */
function isValidIPv6Route(destination: string): boolean {
  const parts = destination.split('/');
  if (parts.length > 2) {
    return false;
  }
  if (parts.length === 2) {
    const prefix = parseInt(parts[1], 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 128 || parts[1] !== String(prefix)) {
      return false;
    }
  }
  return isIPv6(parts[0]);
}

/**
 * High-level wrapper around the native TUN device with IPv6-only configuration helpers.
 *
 * Routing and addressing use a built-in OS backend chosen from the `platform` argument (requires root, EUID 0 on Darwin/Linux).
 */
export class TunTap {
  private device: NativeTunDevice;
  private readonly platformBackend: TunTapPlatform;
  private _isOpen: boolean;
  private _isClosed: boolean;
  private removeExitListener: (() => void) | null = null;

  /**
   * @param name — optional interface name hint for the native layer
   * @param platform — Node.js platform id (e.g. `darwin`, `linux`); defaults to `process.platform`
   */
  constructor(name: string = '', platform: NodeJS.Platform = process.platform) {
    this.device = new nativeTuntap.TunDevice(name);
    this.platformBackend = createTunTapPlatform(platform);
    this._isOpen = false;
    this._isClosed = false;

    // Register cleanup on process exit only.
    // Signal handling is the caller's responsibility — libraries should not
    // install global signal handlers. The kernel cleans up the TUN fd on exit.
    const cleanup = () => {
      if (this._isOpen && !this._isClosed) {
        try {
          this.close();
        } catch (err: unknown) {
          log.error('Error closing TUN device during cleanup:', (err as Error).message);
        }
      }
    };

    process.once('exit', cleanup);
    this.removeExitListener = () => {
      process.removeListener('exit', cleanup);
    };
  }

  /** Whether {@link TunTap.open} has succeeded and {@link TunTap.close} has not run. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Whether {@link TunTap.close} has been called (device cannot be reopened). */
  get isClosed(): boolean {
    return this._isClosed;
  }

  /**
   * Open the TUN device via the native addon.
   *
   * @returns `true` when the device is open
   * @throws {TunTapError} if already closed
   * @throws {TunTapDeviceError} if the device cannot be opened
   * @throws {TunTapPermissionError} if the OS denies access
   */
  open(): boolean {
    if (this._isClosed) {
      throw new TunTapError('Device has been closed and cannot be reopened');
    }

    if (!this._isOpen) {
      try {
        this._isOpen = this.device.open();
        if (!this._isOpen) {
          throw new TunTapDeviceError('Failed to open TUN device');
        }
      } catch (err: unknown) {
        const message = (err as Error).message ?? '';
        if (message.includes('Permission denied') || message.includes('sudo')) {
          throw new TunTapPermissionError(message);
        }
        if (message.includes('not available') || message.includes('does not exist')) {
          throw new TunTapDeviceError(message);
        }
        throw err;
      }
    }
    return this._isOpen;
  }

  /**
   * Close the device and unregister process `exit` cleanup.
   *
   * @returns `true` when closed (idempotent)
   * @throws {TunTapError} on native close failure
   */
  close(): boolean {
    if (this.removeExitListener) {
      this.removeExitListener();
      this.removeExitListener = null;
    }

    if (!this._isClosed) {
      try {
        if (this._isOpen) {
          this.device.close();
          this._isOpen = false;
        }
        this._isClosed = true;
      } catch (err: unknown) {
        throw new TunTapError(`Failed to close device: ${(err as Error).message}`);
      }
    }
    return true;
  }

  /**
   * Read one datagram/packet from the TUN device (blocking in the native layer).
   *
   * @param maxSize — upper bound on bytes to read (default 4096)
   * @returns packet buffer
   * @throws {TunTapError} if not open, closed, or read fails
   * @throws {RangeError} if `maxSize` is out of range
   */
  read(maxSize: number = DEFAULT_READ_BUFFER_SIZE): Buffer {
    this.assertReady();
    if (maxSize <= 0 || maxSize > MAX_BUFFER_SIZE) {
      throw new RangeError(`Read size must be between 1 and ${MAX_BUFFER_SIZE} bytes`);
    }

    try {
      return this.device.read(maxSize);
    } catch (err: unknown) {
      throw new TunTapError(`Read failed: ${(err as Error).message}`);
    }
  }

  /**
   * Write a full IPv6 packet to the TUN device.
   *
   * @param data — L3 payload to write
   * @returns number of bytes written
   * @throws {TunTapError} if not open, closed, or write fails
   * @throws {TypeError} if `data` is not a `Buffer`
   * @throws {RangeError} if `data` exceeds the maximum buffer size
   */
  write(data: Buffer): number {
    this.assertReady();
    if (!Buffer.isBuffer(data)) {
      throw new TypeError('Data must be a Buffer');
    }
    if (data.length === 0) {
      return 0;
    }
    if (data.length > MAX_BUFFER_SIZE) {
      throw new RangeError(`Write data too large (max ${MAX_BUFFER_SIZE} bytes)`);
    }

    try {
      const result = this.device.write(data);
      if (result < 0) {
        throw new TunTapError('Write operation failed');
      }
      return result;
    } catch (err: unknown) {
      throw new TunTapError(`Write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Start libuv-driven polling on the TUN fd; `callback` runs on the Node thread pool per packet.
   *
   * @param callback — invoked with each packet read from the device
   * @param bufferSize — max read size per poll (default 65535)
   * @throws {TunTapError} if not open or closed
   * @throws {TypeError} if `callback` is not a function
   * @throws {RangeError} if `bufferSize` is out of range
   */
  startPolling(callback: PacketCallback, bufferSize: number = MAX_BUFFER_SIZE): void {
    this.assertReady();
    if (typeof callback !== 'function') {
      throw new TypeError('Callback must be a function');
    }
    if (bufferSize <= 0 || bufferSize > MAX_BUFFER_SIZE) {
      throw new RangeError(`Buffer size must be between 1 and ${MAX_BUFFER_SIZE} bytes`);
    }
    this.device.startPolling(callback, bufferSize);
  }

  /** OS-assigned interface name (e.g. `utun4` on macOS). */
  get name(): string {
    return this.device.getName();
  }

  /** File descriptor for the open TUN device (for advanced use). */
  get fd(): number {
    return this.device.getFd();
  }

  /**
   * Configure IPv6 address and MTU on this interface using the platform backend (must run as root on Darwin/Linux).
   *
   * @param address — IPv6 address
   * @param mtu — link MTU (min 1280, max 65535)
   * @throws {TypeError} if `address` is not a valid IPv6 literal
   * @throws {RangeError} if `mtu` is out of range
   * @throws {TunTapError} on backend failure
   */
  async configure(address: string, mtu: number = DEFAULT_MTU): Promise<void> {
    this.assertReady();
    if (!isIPv6(address)) {
      throw new TypeError('Invalid IPv6 address format');
    }
    if (mtu < MIN_MTU || mtu > MAX_BUFFER_SIZE) {
      throw new RangeError(`MTU must be between ${MIN_MTU} and ${MAX_BUFFER_SIZE}`);
    }

    try {
      await this.platformBackend.configure(this.name, address, mtu);
    } catch (err: unknown) {
      if (err instanceof TunTapError) {
        throw err;
      }
      throw new TunTapError(`Failed to configure TUN interface: ${(err as Error).message}`);
    }
  }

  /**
   * Add an IPv6 route via this TUN interface.
   *
   * @param destination — IPv6 address or CIDR (e.g. `fd00::/64`)
   * @throws {TypeError} if `destination` is invalid
   * @throws {TunTapError} on backend failure
   */
  async addRoute(destination: string): Promise<void> {
    this.assertReady();
    if (!destination || typeof destination !== 'string') {
      throw new TypeError('Destination must be a non-empty string');
    }
    if (!isValidIPv6Route(destination)) {
      throw new TypeError('Destination must be a valid IPv6 address or CIDR (e.g., fd00::1/128)');
    }

    try {
      await this.platformBackend.addRoute(this.name, destination);
    } catch (err: unknown) {
      if (err instanceof TunTapError) {
        throw err;
      }
      throw new TunTapError(`Failed to add route: ${(err as Error).message}`);
    }
  }

  /**
   * Remove an IPv6 route previously added for this interface.
   *
   * @param destination — same form as {@link TunTap.addRoute}
   * @throws {TypeError} if `destination` is invalid
   * @throws {TunTapError} if the backend reports an error other than “route missing”
   */
  async removeRoute(destination: string): Promise<void> {
    this.assertReady();
    if (!destination || typeof destination !== 'string') {
      throw new TypeError('Destination must be a non-empty string');
    }
    if (!isValidIPv6Route(destination)) {
      throw new TypeError('Destination must be a valid IPv6 address or CIDR');
    }

    try {
      await this.platformBackend.removeRoute(this.name, destination);
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (message.includes('not in table') || message.includes('No such process')) {
        return;
      }
      throw new TunTapError(`Failed to remove route: ${message}`);
    }
  }

  /**
   * Fetch RX/TX counters for this interface from the OS (e.g. `netstat` / `ip -s`).
   *
   * @returns byte and packet counts plus error counters
   * @throws {TunTapError} if not ready or stats cannot be parsed
   */
  async getStats(): Promise<TunTapInterfaceStats> {
    this.assertReady();

    try {
      return await this.platformBackend.getStats(this.name);
    } catch (err: unknown) {
      if (err instanceof TunTapError) {
        throw err;
      }
      throw new TunTapError(`Failed to get interface statistics: ${(err as Error).message}`);
    }
  }

  /**
   * Throws if the device is not in a usable state (not open or already closed).
   */
  private assertReady(): void {
    if (!this._isOpen) {
      throw new TunTapError('Device not open');
    }
    if (this._isClosed) {
      throw new TunTapError('Device has been closed');
    }
  }
}
