import { createRequire } from 'module';
import { exec } from 'child_process';
import { promisify } from 'util';

interface NativeTuntapModule {
    TunDevice: new (name?: string) => {
        open(): boolean;
        close(): void;
        read(maxSize: number): Buffer;
        write(data: Buffer): number;
        getName(): string;
        getFd(): number;
    };
}

const require = createRequire(import.meta.url);
const nativeTuntap = require('./Release/tuntap.node') as NativeTuntapModule;

const execPromise = promisify(exec);

/**
 * TUN/TAP device for IP tunneling
 */
export class TunTap {
    private device: any;
    private isOpen: boolean;

    constructor(name: string = '') {
        this.device = new nativeTuntap.TunDevice(name);
        this.isOpen = false;
    }

    open(): boolean {
        if (!this.isOpen) {
            this.isOpen = this.device.open();
        }
        return this.isOpen;
    }

    close(): boolean {
        if (this.isOpen) {
            this.device.close();
            this.isOpen = false;
        }
        return true;
    }

    read(maxSize: number = 4096): Buffer {
        if (!this.isOpen) {
            throw new Error('Device not open');
        }
        return this.device.read(maxSize);
    }

    write(data: Buffer): number {
        if (!this.isOpen) {
            throw new Error('Device not open');
        }
        return this.device.write(data);
    }

    get name(): string {
        return this.device.getName();
    }

    get fd(): number {
        return this.device.getFd();
    }

    async configure(address: string, mtu: number = 1500): Promise<void> {
        if (!this.isOpen) {
            throw new Error('Device not open');
        }

        const platform = process.platform;

        if (platform === 'darwin') {
            // macOS configuration
            await execPromise(`sudo ifconfig ${this.name} inet6 ${address} prefixlen 64 up`);
            await execPromise(`sudo ifconfig ${this.name} mtu ${mtu}`);
        } else if (platform === 'linux') {
            // Linux configuration
            await execPromise(`sudo ip -6 addr add ${address}/64 dev ${this.name}`);
            await execPromise(`sudo ip link set dev ${this.name} up mtu ${mtu}`);
        } else {
            throw new Error(`Unsupported platform: ${platform}`);
        }
    }

    async addRoute(destination: string): Promise<void> {
        if (!this.isOpen) {
            throw new Error('Device not open');
        }

        const platform = process.platform;

        if (platform === 'darwin') {
            // macOS route
            await execPromise(`sudo route -n add -inet6 ${destination} -interface ${this.name}`);
        } else if (platform === 'linux') {
            // Linux route
            await execPromise(`sudo ip -6 route add ${destination} dev ${this.name}`);
        } else {
            throw new Error(`Unsupported platform: ${platform}`);
        }
    }
}
