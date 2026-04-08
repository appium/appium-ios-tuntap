import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { isIPv6 } from 'node:net';
import { promisify } from 'node:util';

import { log } from './logger.js';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const PLATFORM = process.platform;

interface NativeTunDevice {
    open(): boolean;
    close(): void;
    read(maxSize: number): Buffer;
    write(data: Buffer): number;
    getName(): string;
    getFd(): number;
    startPolling(callback: (data: Buffer) => void, bufferSize?: number): void;
}

interface NativeTuntapModule {
    TunDevice: new (name?: string) => NativeTunDevice;
}

const nativeTuntap = require('../build/Release/tuntap.node') as NativeTuntapModule;

// Custom error types
export class TunTapError extends Error {
    constructor(message: string, public code?: string) {
        super(message);
        this.name = 'TunTapError';
    }
}

export class TunTapPermissionError extends TunTapError {
    constructor(message: string) {
        super(message, 'EPERM');
        this.name = 'TunTapPermissionError';
    }
}

export class TunTapDeviceError extends TunTapError {
    constructor(message: string) {
        super(message, 'ENODEV');
        this.name = 'TunTapDeviceError';
    }
}

/**
 * Validates an IPv6 route destination (address with optional CIDR prefix).
 */
function isValidIPv6Route(destination: string): boolean {
    const parts = destination.split('/');
    if (parts.length > 2) return false;
    if (parts.length === 2) {
        const prefix = parseInt(parts[1], 10);
        if (isNaN(prefix) || prefix < 0 || prefix > 128 || parts[1] !== String(prefix)) return false;
    }
    return isIPv6(parts[0]);
}

/**
 * TUN/TAP device for IP tunneling
 */
export class TunTap {
    private device: NativeTunDevice;
    private _isOpen: boolean;
    private _isClosed: boolean;
    private cleanupHandler: (() => void) | null = null;

    constructor(name: string = '') {
        this.device = new nativeTuntap.TunDevice(name);
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
        this.cleanupHandler = () => {
            process.removeListener('exit', cleanup);
        };
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    get isClosed(): boolean {
        return this._isClosed;
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

    close(): boolean {
        if (!this._isClosed) {
            try {
                if (this._isOpen) {
                    this.device.close();
                    this._isOpen = false;
                }
                this._isClosed = true;

                if (this.cleanupHandler) {
                    this.cleanupHandler();
                    this.cleanupHandler = null;
                }
            } catch (err: unknown) {
                throw new TunTapError(`Failed to close device: ${(err as Error).message}`);
            }
        }
        return true;
    }

    read(maxSize: number = 4096): Buffer {
        this.assertReady();
        if (maxSize <= 0 || maxSize > 65_536) {
            throw new RangeError('Read size must be between 1 and 65536 bytes');
        }

        try {
            return this.device.read(maxSize);
        } catch (err: unknown) {
            throw new TunTapError(`Read failed: ${(err as Error).message}`);
        }
    }

    write(data: Buffer): number {
        this.assertReady();
        if (!Buffer.isBuffer(data)) {
            throw new TypeError('Data must be a Buffer');
        }
        if (data.length === 0) {
            return 0;
        }
        if (data.length > 65_536) {
            throw new RangeError('Write data too large (max 65536 bytes)');
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
     * Start event-driven reading from the TUN device.
     * The callback is invoked with each packet read from the device.
     */
    startPolling(callback: (data: Buffer) => void, bufferSize: number = 65_536): void {
        this.assertReady();
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }
        this.device.startPolling(callback, bufferSize);
    }

    get name(): string {
        return this.device.getName();
    }

    get fd(): number {
        return this.device.getFd();
    }

    async configure(address: string, mtu: number = 1500): Promise<void> {
        this.assertReady();
        if (!isIPv6(address)) {
            throw new TypeError('Invalid IPv6 address format');
        }
        if (mtu < 1280 || mtu > 65_535) {
            throw new RangeError('MTU must be between 1280 and 65535');
        }

        try {
            if (PLATFORM === 'darwin') {
                await execFileAsync('sudo', ['ifconfig', this.name, 'inet6', address, 'prefixlen', '64', 'up']);
                await execFileAsync('sudo', ['ifconfig', this.name, 'mtu', String(mtu)]);
            } else if (PLATFORM === 'linux') {
                await this.configureLinux(address, mtu);
            } else {
                throw new TunTapError(`Unsupported platform: ${PLATFORM}`);
            }
        } catch (err: unknown) {
            if (err instanceof TunTapError) throw err;
            throw new TunTapError(`Failed to configure TUN interface: ${(err as Error).message}`);
        }
    }

    private async configureLinux(address: string, mtu: number): Promise<void> {
        try {
            await execFileAsync('which', ['ip']);
        } catch {
            throw new TunTapError(
                'The "ip" command is not available. Please install iproute2 (e.g., sudo apt install iproute2)',
            );
        }

        try {
            await execFileAsync('sudo', ['ip', '-6', 'addr', 'add', `${address}/64`, 'dev', this.name]);
            await execFileAsync('sudo', ['ip', 'link', 'set', 'dev', this.name, 'up', 'mtu', String(mtu)]);
        } catch (err: unknown) {
            const message = (err as Error).message;
            if (message.includes('Permission denied')) {
                throw new TunTapPermissionError(
                    'Permission denied when configuring network interface. Run with sudo.',
                );
            }
            if (message.includes('File exists')) {
                log.warn(`Address ${address} may already be configured on ${this.name}`);
                return;
            }
            throw err;
        }
    }

    async addRoute(destination: string): Promise<void> {
        this.assertReady();
        if (!destination || typeof destination !== 'string') {
            throw new TypeError('Destination must be a non-empty string');
        }
        if (!isValidIPv6Route(destination)) {
            throw new TypeError('Destination must be a valid IPv6 address or CIDR (e.g., fd00::1/128)');
        }

        try {
            if (PLATFORM === 'darwin') {
                await execFileAsync('sudo', ['route', '-n', 'add', '-inet6', destination, '-interface', this.name]);
            } else if (PLATFORM === 'linux') {
                await this.addRouteLinux(destination);
            } else {
                throw new TunTapError(`Unsupported platform: ${PLATFORM}`);
            }
        } catch (err: unknown) {
            if (err instanceof TunTapError) throw err;
            throw new TunTapError(`Failed to add route: ${(err as Error).message}`);
        }
    }

    private async addRouteLinux(destination: string): Promise<void> {
        try {
            await execFileAsync('sudo', ['ip', '-6', 'route', 'add', destination, 'dev', this.name]);
        } catch (err: unknown) {
            const message = (err as Error).message;
            if (message.includes('Permission denied')) {
                throw new TunTapPermissionError('Permission denied when adding route. Run with sudo.');
            }
            if (message.includes('File exists')) {
                log.info(`Route to ${destination} already exists`);
                return;
            }
            throw err;
        }
    }

    async removeRoute(destination: string): Promise<void> {
        this.assertReady();
        if (!destination || typeof destination !== 'string') {
            throw new TypeError('Destination must be a non-empty string');
        }
        if (!isValidIPv6Route(destination)) {
            throw new TypeError('Destination must be a valid IPv6 address or CIDR');
        }

        try {
            if (PLATFORM === 'darwin') {
                await execFileAsync('sudo', ['route', '-n', 'delete', '-inet6', destination]);
            } else if (PLATFORM === 'linux') {
                await execFileAsync('sudo', ['ip', '-6', 'route', 'del', destination, 'dev', this.name]);
            } else {
                throw new TunTapError(`Unsupported platform: ${PLATFORM}`);
            }
        } catch (err: unknown) {
            const message = (err as Error).message;
            if (message.includes('not in table') || message.includes('No such process')) {
                return;
            }
            throw new TunTapError(`Failed to remove route: ${message}`);
        }
    }

    /**
     * Get interface statistics.
     */
    async getStats(): Promise<{
        rxBytes: number;
        txBytes: number;
        rxPackets: number;
        txPackets: number;
        rxErrors: number;
        txErrors: number;
    }> {
        this.assertReady();

        try {
            if (PLATFORM === 'darwin') {
                return await this.getStatsDarwin();
            }
            if (PLATFORM === 'linux') {
                return await this.getStatsLinux();
            }
            throw new TunTapError(`Unsupported platform: ${PLATFORM}`);
        } catch (err: unknown) {
            if (err instanceof TunTapError) throw err;
            throw new TunTapError(`Failed to get interface statistics: ${(err as Error).message}`);
        }
    }

    private async getStatsDarwin() {
        const { stdout } = await execFileAsync('netstat', ['-I', this.name, '-b']);
        const lines = stdout.trim().split('\n');
        if (lines.length < 2) {
            throw new TunTapError('Unexpected netstat output');
        }

        const stats = lines[1].split(/\s+/);
        return {
            rxPackets: parseInt(stats[4], 10) || 0,
            rxErrors: parseInt(stats[5], 10) || 0,
            rxBytes: parseInt(stats[6], 10) || 0,
            txPackets: parseInt(stats[7], 10) || 0,
            txErrors: parseInt(stats[8], 10) || 0,
            txBytes: parseInt(stats[9], 10) || 0,
        };
    }

    private async getStatsLinux() {
        const { stdout } = await execFileAsync('ip', ['-s', 'link', 'show', this.name]);
        const lines = stdout.trim().split('\n');

        const rxIndex = lines.findIndex((line) => line.includes('RX:'));
        const txIndex = lines.findIndex((line) => line.includes('TX:'));

        if (rxIndex === -1 || txIndex === -1) {
            throw new TunTapError('Could not parse interface statistics');
        }

        const rxStats = lines[rxIndex + 1].trim().split(/\s+/);
        const txStats = lines[txIndex + 1].trim().split(/\s+/);

        return {
            rxBytes: parseInt(rxStats[0], 10) || 0,
            rxPackets: parseInt(rxStats[1], 10) || 0,
            rxErrors: parseInt(rxStats[2], 10) || 0,
            txBytes: parseInt(txStats[0], 10) || 0,
            txPackets: parseInt(txStats[1], 10) || 0,
            txErrors: parseInt(txStats[2], 10) || 0,
        };
    }
}
