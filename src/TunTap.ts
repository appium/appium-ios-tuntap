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
const nativeTuntap = require('../build/Release/tuntap.node') as NativeTuntapModule;

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

        try {
            if (platform === 'darwin') {
                // macOS configuration
                await execPromise(`sudo ifconfig ${this.name} inet6 ${address} prefixlen 64 up`);
                await execPromise(`sudo ifconfig ${this.name} mtu ${mtu}`);
            } else if (platform === 'linux') {
                // Linux configuration
                try {
                    // Check if ip command is available
                    await execPromise('which ip');
                } catch (err) {
                    throw new Error('The "ip" command is not available. Please install the iproute2 package (e.g., sudo apt install iproute2)');
                }
                
                try {
                    await execPromise(`sudo ip -6 addr add ${address}/64 dev ${this.name}`);
                    await execPromise(`sudo ip link set dev ${this.name} up mtu ${mtu}`);
                } catch (err: any) {
                    if (err.message.includes('Permission denied')) {
                        throw new Error(`Permission denied when configuring network interface. Make sure you have sudo privileges or run the application with sudo.`);
                    } else {
                        throw err;
                    }
                }
            } else {
                throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            throw new Error(`Failed to configure TUN interface: ${err.message}`);
        }
    }

    async addRoute(destination: string): Promise<void> {
        if (!this.isOpen) {
            throw new Error('Device not open');
        }

        const platform = process.platform;

        try {
            if (platform === 'darwin') {
                // macOS route
                await execPromise(`sudo route -n add -inet6 ${destination} -interface ${this.name}`);
            } else if (platform === 'linux') {
                // Linux route
                try {
                    await execPromise(`sudo ip -6 route add ${destination} dev ${this.name}`);
                } catch (err: any) {
                    if (err.message.includes('Permission denied')) {
                        throw new Error(`Permission denied when adding route. Make sure you have sudo privileges or run the application with sudo.`);
                    } else if (err.message.includes('File exists')) {
                        // Route already exists, which is fine
                        console.log(`Route to ${destination} already exists`);
                    } else {
                        throw err;
                    }
                }
            } else {
                throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            // Only throw if it's not the "route already exists" case we handled above
            if (!err.message.includes('Route to') && !err.message.includes('already exists')) {
                throw new Error(`Failed to add route: ${err.message}`);
            }
        }
    }
}
