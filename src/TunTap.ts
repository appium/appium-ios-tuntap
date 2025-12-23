import { createRequire } from 'module';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './logger.js';

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
 * TUN/TAP device for IP tunneling
 */
export class TunTap {
    private device: any;
    private isOpen: boolean;
    private isClosed: boolean;
    private cleanupHandlers: (() => void)[] = [];

    constructor(name: string = '') {
        this.device = new nativeTuntap.TunDevice(name);
        this.isOpen = false;
        this.isClosed = false;

        // Register cleanup on process exit
        const cleanup = () => {
            if (this.isOpen && !this.isClosed) {
                try {
                    this.close();
                } catch (err) {
                    log.error('Error closing TUN device during cleanup:', err);
                }
            }
        };

        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);

        this.cleanupHandlers.push(() => {
            process.removeListener('exit', cleanup);
            process.removeListener('SIGINT', cleanup);
            process.removeListener('SIGTERM', cleanup);
        });
    }

    open(): boolean {
        if (this.isClosed) {
            throw new TunTapError('Device has been closed and cannot be reopened');
        }

        if (!this.isOpen) {
            try {
                this.isOpen = this.device.open();
                if (!this.isOpen) {
                    throw new TunTapDeviceError('Failed to open TUN device');
                }
            } catch (err: any) {
                // Re-throw with more specific error types
                if (err.message?.includes('Permission denied') || err.message?.includes('sudo')) {
                    throw new TunTapPermissionError(err.message);
                } else if (err.message?.includes('not available') || err.message?.includes('does not exist')) {
                    throw new TunTapDeviceError(err.message);
                }
                throw err;
            }
        }
        return this.isOpen;
    }

    close(): boolean {
        if (!this.isClosed) {
            try {
                if (this.isOpen) {
                    this.device.close();
                    this.isOpen = false;
                }
                this.isClosed = true;

                // Run cleanup handlers
                this.cleanupHandlers.forEach((handler) => handler());
                this.cleanupHandlers = [];
            } catch (err: any) {
                throw new TunTapError(`Failed to close device: ${err.message}`);
            }
        }
        return true;
    }

    read(maxSize: number = 4096): Buffer {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }
        if (this.isClosed) {
            throw new TunTapError('Device has been closed');
        }

        if (maxSize <= 0 || maxSize > 65536) {
            throw new RangeError('Read size must be between 1 and 65536 bytes');
        }

        try {
            return this.device.read(maxSize);
        } catch (err: any) {
            throw new TunTapError(`Read failed: ${err.message}`);
        }
    }

    write(data: Buffer): number {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }
        if (this.isClosed) {
            throw new TunTapError('Device has been closed');
        }

        if (!Buffer.isBuffer(data)) {
            throw new TypeError('Data must be a Buffer');
        }

        if (data.length === 0) {
            return 0;
        }

        if (data.length > 65536) {
            throw new RangeError('Write data too large (max 65536 bytes)');
        }

        try {
            const result = this.device.write(data);
            if (result < 0) {
                throw new TunTapError('Write operation failed');
            }
            return result;
        } catch (err: any) {
            throw new TunTapError(`Write failed: ${err.message}`);
        }
    }

    get name(): string {
        return this.device.getName();
    }

    get fd(): number {
        return this.device.getFd();
    }

    async configure(address: string, mtu: number = 1500): Promise<void> {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }
        if (this.isClosed) {
            throw new TunTapError('Device has been closed');
        }

        // Validate IPv6 address format
        const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

        if (!ipv6Regex.test(address)) {
            throw new TypeError('Invalid IPv6 address format');
        }

        // Validate MTU
        if (mtu < 1280 || mtu > 65535) {
            throw new RangeError('MTU must be between 1280 and 65535');
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
                } catch {
                    throw new TunTapError('The "ip" command is not available. Please install the iproute2 package (e.g., sudo apt install iproute2)');
                }

                try {
                    await execPromise(`sudo ip -6 addr add ${address}/64 dev ${this.name}`);
                    await execPromise(`sudo ip link set dev ${this.name} up mtu ${mtu}`);
                } catch (err: any) {
                    if (err.message.includes('Permission denied')) {
                        throw new TunTapPermissionError(`Permission denied when configuring network interface. Make sure you have sudo privileges or run the application with sudo.`);
                    } else if (err.message.includes('File exists')) {
                        // Address already configured, which might be okay
                        log.warn(`Address ${address} may already be configured on ${this.name}`);
                    } else {
                        throw err;
                    }
                }
            } else if (platform === 'win32') {
                // Windows configuration using PowerShell
                try {
                    // Find the adapter by name (partial match since Windows may add prefixes)
                    const findCmd = `powershell -Command "Get-NetAdapter | Where-Object {$_.Name -like '*${this.name}*' -or $_.InterfaceDescription -like '*${this.name}*'} | Select-Object -ExpandProperty ifIndex"`;
                    const { stdout: ifIndexStr } = await execPromise(findCmd);
                    const ifIndex = ifIndexStr.trim();

                    if (!ifIndex) {
                        throw new TunTapError(`Could not find network adapter with name matching '${this.name}'`);
                    }

                    // Add IPv6 address
                    const addAddrCmd = `powershell -Command "New-NetIPAddress -InterfaceIndex ${ifIndex} -IPAddress '${address}' -PrefixLength 64 -AddressFamily IPv6 -ErrorAction Stop"`;
                    await execPromise(addAddrCmd);

                    // Set MTU (optional, may not be supported on all adapters)
                    try {
                        const setMtuCmd = `powershell -Command "Set-NetIPInterface -InterfaceIndex ${ifIndex} -NlMtu ${mtu} -ErrorAction Stop"`;
                        await execPromise(setMtuCmd);
                    } catch (err: any) {
                        // MTU setting may fail on some adapters, log but don't fail
                        log.warn(`Failed to set MTU on ${this.name}: ${err.message}`);
                    }

                    // Enable the adapter
                    const enableCmd = `powershell -Command "$adapter = Get-NetAdapter -InterfaceIndex ${ifIndex}; Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop"`;
                    await execPromise(enableCmd);
                } catch (err: any) {
                    if (err.message.includes('Access is denied') || err.message.includes('Administrator')) {
                        throw new TunTapPermissionError(`Permission denied when configuring network interface. Make sure you are running as Administrator.`);
                    } else if (err.message.includes('already exists') || err.message.includes('duplicate')) {
                        // Address already configured, which might be okay
                        log.warn(`Address ${address} may already be configured on ${this.name}`);
                    } else {
                        throw err;
                    }
                }
            } else {
                throw new TunTapError(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            if (err instanceof TunTapError) {
                throw err;
            }
            throw new TunTapError(`Failed to configure TUN interface: ${err.message}`);
        }
    }

    async addRoute(destination: string): Promise<void> {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }
        if (this.isClosed) {
            throw new TunTapError('Device has been closed');
        }

        // Basic validation of destination format
        if (!destination || typeof destination !== 'string') {
            throw new TypeError('Destination must be a non-empty string');
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
                        throw new TunTapPermissionError(`Permission denied when adding route. Make sure you have sudo privileges or run the application with sudo.`);
                    } else if (err.message.includes('File exists')) {
                        // Route already exists, which is fine
                        log.info(`Route to ${destination} already exists`);
                    } else {
                        throw err;
                    }
                }
            } else if (platform === 'win32') {
                // Windows route using netsh or route command
                try {
                    // Find the adapter interface index
                    const findCmd = `powershell -Command "Get-NetAdapter | Where-Object {$_.Name -like '*${this.name}*' -or $_.InterfaceDescription -like '*${this.name}*'} | Select-Object -ExpandProperty ifIndex"`;
                    const { stdout: ifIndexStr } = await execPromise(findCmd);
                    const ifIndex = ifIndexStr.trim();

                    if (!ifIndex) {
                        throw new TunTapError(`Could not find network adapter with name matching '${this.name}'`);
                    }

                    // Add IPv6 route using PowerShell
                    const addRouteCmd = `powershell -Command "New-NetRoute -DestinationPrefix '${destination}' -InterfaceIndex ${ifIndex} -ErrorAction Stop"`;
                    await execPromise(addRouteCmd);
                } catch (err: any) {
                    if (err.message.includes('Access is denied') || err.message.includes('Administrator')) {
                        throw new TunTapPermissionError(`Permission denied when adding route. Make sure you are running as Administrator.`);
                    } else if (err.message.includes('already exists') || err.message.includes('duplicate')) {
                        // Route already exists, which is fine
                        log.info(`Route to ${destination} already exists`);
                    } else {
                        throw err;
                    }
                }
            } else {
                throw new TunTapError(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            // Only throw if it's not the "route already exists" case we handled above
            if (err instanceof TunTapError) {
                throw err;
            }
            if (!err.message.includes('Route to') && !err.message.includes('already exists')) {
                throw new TunTapError(`Failed to add route: ${err.message}`);
            }
        }
    }

    async removeRoute(destination: string): Promise<void> {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }

        const platform = process.platform;

        try {
            if (platform === 'darwin') {
                // macOS route removal
                await execPromise(`sudo route -n delete -inet6 ${destination}`);
            } else if (platform === 'linux') {
                // Linux route removal
                await execPromise(`sudo ip -6 route del ${destination} dev ${this.name}`);
            } else if (platform === 'win32') {
                // Windows route removal
                try {
                    // Find the adapter interface index
                    const findCmd = `powershell -Command "Get-NetAdapter | Where-Object {$_.Name -like '*${this.name}*' -or $_.InterfaceDescription -like '*${this.name}*'} | Select-Object -ExpandProperty ifIndex"`;
                    const { stdout: ifIndexStr } = await execPromise(findCmd);
                    const ifIndex = ifIndexStr.trim();

                    if (!ifIndex) {
                        throw new TunTapError(`Could not find network adapter with name matching '${this.name}'`);
                    }

                    // Remove IPv6 route using PowerShell
                    const removeRouteCmd = `powershell -Command "Remove-NetRoute -DestinationPrefix '${destination}' -InterfaceIndex ${ifIndex} -Confirm:$false -ErrorAction Stop"`;
                    await execPromise(removeRouteCmd);
                } catch (err: any) {
                    // Ignore if route doesn't exist
                    if (!err.message.includes('No matching') && !err.message.includes('not found')) {
                        throw err;
                    }
                }
            } else {
                throw new TunTapError(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            // Ignore errors if route doesn't exist
            if (!err.message.includes('not in table') && !err.message.includes('No such process')) {
                throw new TunTapError(`Failed to remove route: ${err.message}`);
            }
        }
    }

    /**
     * Get interface statistics
     */
    async getStats(): Promise<{
        rxBytes: number;
        txBytes: number;
        rxPackets: number;
        txPackets: number;
        rxErrors: number;
        txErrors: number;
    }> {
        if (!this.isOpen) {
            throw new TunTapError('Device not open');
        }

        const platform = process.platform;

        try {
            if (platform === 'darwin') {
                const { stdout } = await execPromise(`netstat -I ${this.name} -b`);
                // Parse macOS netstat output
                const lines = stdout.trim().split('\n');
                if (lines.length < 2) {
                    throw new Error('Unexpected netstat output');
                }

                const stats = lines[1].split(/\s+/);
                return {
                    rxPackets: parseInt(stats[4], 10) || 0,
                    rxErrors: parseInt(stats[5], 10) || 0,
                    rxBytes: parseInt(stats[6], 10) || 0,
                    txPackets: parseInt(stats[7], 10) || 0,
                    txErrors: parseInt(stats[8], 10) || 0,
                    txBytes: parseInt(stats[9], 10) || 0
                };
            } else if (platform === 'linux') {
                const { stdout } = await execPromise(`ip -s link show ${this.name}`);
                // Parse Linux ip command output
                const lines = stdout.trim().split('\n');

                // Find RX and TX statistics
                let rxIndex = -1;
                let txIndex = -1;

                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('RX:')) {rxIndex = i + 1;}
                    if (lines[i].includes('TX:')) {txIndex = i + 1;}
                }

                if (rxIndex === -1 || txIndex === -1) {
                    throw new Error('Could not parse interface statistics');
                }

                const rxStats = lines[rxIndex].trim().split(/\s+/);
                const txStats = lines[txIndex].trim().split(/\s+/);

                return {
                    rxBytes: parseInt(rxStats[0], 10) || 0,
                    rxPackets: parseInt(rxStats[1], 10) || 0,
                    rxErrors: parseInt(rxStats[2], 10) || 0,
                    txBytes: parseInt(txStats[0], 10) || 0,
                    txPackets: parseInt(txStats[1], 10) || 0,
                    txErrors: parseInt(txStats[2], 10) || 0
                };
            } else if (platform === 'win32') {
                // Windows statistics using PowerShell
                // First get the adapter name (not just matching, but exact name)
                const findCmd = `powershell -NoProfile -Command "Get-NetAdapter | Where-Object {$_.Name -like '*${this.name}*' -or $_.InterfaceDescription -like '*${this.name}*'} | Select-Object -First 1 -ExpandProperty Name"`;
                const { stdout: adapterName } = await execPromise(findCmd);
                const trimmedName = adapterName.trim();

                if (!trimmedName) {
                    throw new TunTapError(`Could not find network adapter with name matching '${this.name}'`);
                }

                // Get adapter statistics using the adapter name
                // Use Get-NetAdapterStatistics which requires -Name parameter
                const statsCmd = `powershell -NoProfile -Command "$adapter = Get-NetAdapter -Name '${trimmedName}'; $stats = Get-NetAdapterStatistics -Name $adapter.Name; @{ReceivedBytes=$stats.ReceivedBytes; SentBytes=$stats.SentBytes; ReceivedUnicastPackets=$stats.ReceivedUnicastPackets; SentUnicastPackets=$stats.SentUnicastPackets; ReceivedDiscardedPackets=$stats.ReceivedDiscardedPackets; OutboundDiscardedPackets=$stats.OutboundDiscardedPackets} | ConvertTo-Json"`;
                const { stdout: statsJson } = await execPromise(statsCmd);
                const stats = JSON.parse(statsJson);

                return {
                    rxBytes: parseInt(stats.ReceivedBytes, 10) || 0,
                    rxPackets: parseInt(stats.ReceivedUnicastPackets, 10) || 0,
                    rxErrors: parseInt(stats.ReceivedDiscardedPackets, 10) || 0,
                    txBytes: parseInt(stats.SentBytes, 10) || 0,
                    txPackets: parseInt(stats.SentUnicastPackets, 10) || 0,
                    txErrors: parseInt(stats.OutboundDiscardedPackets, 10) || 0
                };
            } else {
                throw new TunTapError(`Unsupported platform: ${platform}`);
            }
        } catch (err: any) {
            throw new TunTapError(`Failed to get interface statistics: ${err.message}`);
        }
    }
}
