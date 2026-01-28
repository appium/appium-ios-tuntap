import { log } from './logger.js';
import { TunTap } from './TunTap.js';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { Buffer } from 'node:buffer';

interface TunnelClientParameters {
    address: string;
    mtu: number;
}

interface TunnelInfo {
    clientParameters: TunnelClientParameters;
    serverAddress: string;
    serverRSDPort?: number;
}

export interface PacketData {
    protocol: 'TCP' | 'UDP';
    src: string;
    dst: string;
    sourcePort: number;
    destPort: number;
    payload: Buffer;
}

export interface PacketConsumer {
    onPacket(packet: PacketData): void;
}

export interface TunnelConnection {
    Address: string;
    RsdPort?: number;
    tunnelManager: TunnelManager;
    closer: () => Promise<void>;
    addPacketConsumer(consumer: PacketConsumer): void;
    removePacketConsumer(consumer: PacketConsumer): void;
    getPacketStream(): AsyncIterable<PacketData>;
}

// Global registry for active tunnel managers
const activeTunnelManagers = new Set<TunnelManager>();

// Setup process signal handlers
let signalHandlersSetup = false;
function setupSignalHandlers() {
    if (signalHandlersSetup) {return;}
    signalHandlersSetup = true;

    const gracefulShutdown = async (signal: string) => {
        log.debug(`Received ${signal}, initiating graceful shutdown...`);

        // Copy the set to avoid modification during iteration
        const managers = Array.from(activeTunnelManagers);

        // Stop all tunnel managers
        await Promise.all(managers.map((manager) => {
            try {
                return manager.stop();
            } catch (err) {
                log.error('Error stopping tunnel manager:', err);
            }
        }));

        log.debug('All tunnel managers stopped, exiting...');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', async (err) => {
        log.error('Uncaught exception:', err);
        await gracefulShutdown('uncaughtException');
        process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        log.error(`Unhandled rejection at: ${promise} reason: ${reason}`);
    });
}

export class TunnelManager extends EventEmitter {
    private tun: TunTap | null;
    private cancelled: boolean;
    private readInterval: NodeJS.Timeout | null;
    private buffer: Buffer;
    private packetConsumers: Set<PacketConsumer>;
    private packetQueue: PacketData[];
    private deviceConn: Socket | null;
    private cleanupPromise: Promise<void> | null;

    constructor() {
        super();
        this.tun = null;
        this.cancelled = false;
        this.readInterval = null;
        this.buffer = Buffer.alloc(0);
        this.packetConsumers = new Set();
        this.packetQueue = [];
        this.deviceConn = null;
        this.cleanupPromise = null;

        // Setup signal handlers on first tunnel manager creation
        setupSignalHandlers();

        // Register this manager
        activeTunnelManagers.add(this);
    }

    addPacketConsumer(consumer: PacketConsumer): void {
        this.packetConsumers.add(consumer);
    }

    removePacketConsumer(consumer: PacketConsumer): void {
        this.packetConsumers.delete(consumer);
    }

    async *getPacketStream(): AsyncIterable<PacketData> {
        const queue: PacketData[] = [];
        let resolver: ((value: IteratorResult<PacketData>) => void) | null = null;

        const consumer: PacketConsumer = {
            onPacket: (packet) => {
                if (resolver) {
                    resolver({ value: packet, done: false });
                    resolver = null;
                } else {
                    queue.push(packet);
                }
            }
        };

        this.addPacketConsumer(consumer);

        try {
            while (!this.cancelled) {
                if (queue.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    yield queue.shift()!;
                } else {
                    yield await new Promise<PacketData>((resolve) => {
                        resolver = (result) => {
                            if (!result.done) {
                                resolve(result.value);
                            }
                        };
                    });
                }
            }
        } finally {
            this.removePacketConsumer(consumer);
        }
    }

    async setupInterface(tunnelInfo: TunnelInfo): Promise<{ name: string; mtu: number; interface: TunTap }> {
        log.debug(`Setting up tunnel with parameters:`, tunnelInfo);

        try {
            this.tun = new TunTap();

            // Open the TUN device
            if (!this.tun.open()) {
                throw new Error('Failed to open TUN device');
            }

            log.debug(`Opened TUN device: ${this.tun.name}`);

            // Configure the TUN device with IPv6 address and MTU
            await this.tun.configure(tunnelInfo.clientParameters.address, tunnelInfo.clientParameters.mtu);

            // Add route for the server address
            await this.tun.addRoute(`${tunnelInfo.serverAddress}/128`);

            log.debug(`Configured TUN interface ${this.tun.name} with address ${tunnelInfo.clientParameters.address} and MTU ${tunnelInfo.clientParameters.mtu}`);

            return {
                name: this.tun.name,
                mtu: tunnelInfo.clientParameters.mtu,
                interface: this.tun
            };
        } catch (err: any) {
            log.error(`Error setting up TUN interface: ${err.message}`);
            if (this.tun) {
                try {
                    this.tun.close();
                } catch (closeErr) {
                    log.error('Error closing TUN device:', closeErr);
                }
                this.tun = null;
            }
            throw err;
        }
    }

    startForwarding(deviceConn: Socket): void {
        if (!this.tun) {
            log.error('TUN device is not set up');
            return;
        }

        this.deviceConn = deviceConn;
        log.debug(`Starting bidirectional data forwarding for ${this.tun.name}`);

        // Handle data from the device connection
        deviceConn.on('data', (data: Buffer) => {
            if (this.cancelled) {return;}

            try {
                // Add data to buffer
                this.buffer = Buffer.concat([this.buffer, data]);

                // Process IPv6 packets
                this.processBuffer();
            } catch (err: any) {
                if (!this.cancelled) {
                    log.error('Error processing device data:', err.message);
                }
            }
        });

        // Set up TUN read loop
        this.startTunReadLoop(deviceConn);

        // Listen for device connection close
        deviceConn.on('close', async () => {
            log.debug('Device connection closed, stopping tunnel');
            try {
                await this.stop();
            } catch (err) {
                log.error('Error stopping tunnel: ', err);
            }
        });

        deviceConn.on('error', (err: Error) => {
            log.error('Device connection error: ', err);
        });
    }

    private processBuffer(): void {
        let offset = 0;

        // Process as many complete packets as available
        while (offset + 40 <= this.buffer.length) {
            // Extract IPv6 header (fixed 40 bytes)
            const header = this.buffer.slice(offset, offset + 40);

            // Ensure this is an IPv6 packet (version 6)
            const version = (header[0] >> 4) & 0x0F;
            if (version !== 6) {
                offset++;
                continue;
            }

            // Get payload length from the IPv6 header
            const payloadLength = header.readUInt16BE(4);

            // Ensure we have the full packet (IPv6 header + payload)
            if (offset + 40 + payloadLength > this.buffer.length) {
                break; // Wait for more data
            }

            // Extract the complete IPv6 packet
            const packet = this.buffer.slice(offset, offset + 40 + payloadLength);

            // Extract source and destination IPv6 addresses
            const src = formatIPv6Address(packet.slice(8, 24));
            const dst = formatIPv6Address(packet.slice(24, 40));

            // Get the IPv6 next header value
            const nextHeader = header[6];
            log.debug(`Processing packet: nextHeader=${nextHeader}, totalLength=${40 + payloadLength}`);

            try {
                if (!this.tun) {
                    log.error('TUN device is null during packet processing');
                    break;
                }

                const bytesWritten = this.tun.write(packet);
                log.debug(`Device → TUN: ${bytesWritten} bytes, IPv6 src=${src}, dst=${dst}`);

                // Handle UDP packets (nextHeader === 17)
                if (nextHeader === 17) {
                    const payload = packet.slice(40);
                    log.debug(`UDP packet detected: payload length=${payload.length}`);
                    if (payload.length < 8) {
                        log.debug('UDP payload too short, not emitting event.');
                    } else {
                        const sourcePort = payload.readUInt16BE(0);
                        const destPort = payload.readUInt16BE(2);
                        const udpPayload = payload.slice(8);
                        const packetData: PacketData = {
                            protocol: 'UDP',
                            src,
                            dst,
                            sourcePort,
                            destPort,
                            payload: udpPayload
                        };
                        this.emit('data', packetData);
                        this.packetConsumers.forEach((consumer) => {
                            try {
                                consumer.onPacket(packetData);
                            } catch (err) {
                                log.error('Error in packet consumer:', err);
                            }
                        });
                        log.debug('Emitted data event for UDP packet');
                    }
                }
                // Handle TCP packets (nextHeader === 6)
                else if (nextHeader === 6) {
                    const tcpHeaderStart = 40;
                    if (packet.length < tcpHeaderStart + 20) {
                        log.debug('TCP packet too short for minimum header, skipping.');
                    } else {
                        const sourcePort = packet.readUInt16BE(tcpHeaderStart);
                        const destPort = packet.readUInt16BE(tcpHeaderStart + 2);
                        const dataOffsetByte = packet.readUInt8(tcpHeaderStart + 12);
                        const tcpHeaderLength = (dataOffsetByte >> 4) * 4;
                        if (packet.length < tcpHeaderStart + tcpHeaderLength) {
                            log.debug('TCP header length exceeds packet length, skipping.');
                        } else {
                            const tcpPayload = packet.slice(tcpHeaderStart + tcpHeaderLength);
                            log.debug(`TCP packet detected: headerLength=${tcpHeaderLength}, payload length=${tcpPayload.length}`);
                            const packetData: PacketData = {
                                protocol: 'TCP',
                                src,
                                dst,
                                sourcePort,
                                destPort,
                                payload: tcpPayload
                            };
                            this.emit('data', packetData);
                            this.packetConsumers.forEach((consumer) => {
                                try {
                                    consumer.onPacket(packetData);
                                } catch (err) {
                                    log.error('Error in packet consumer:', err);
                                }
                            });
                            log.debug('Emitted data event for TCP packet');
                        }
                    }
                } else {
                    log.debug('Packet is not UDP or TCP (nextHeader !== 17 and !== 6)');
                }
            } catch (err: any) {
                log.error(`Error writing to TUN: ${err.message}`);
            }

            // Move to the next packet
            offset += 40 + payloadLength;
        }

        // Keep any remaining partial data
        if (offset > 0) {
            this.buffer = this.buffer.slice(offset);
        }
    }

    private startTunReadLoop(deviceConn: Socket): void {
        this.readInterval = setInterval(() => {
            if (this.cancelled || !this.tun) {return;}

            try {
                // Read from TUN
                const data = this.tun.read(16384); // A large buffer for MTU

                // If we got data, send it to the device
                if (data && data.length > 0) {
                    if (data.length >= 40) { // Minimum IPv6 header size
                        log.debug(`TUN → Device: ${data.length} bytes, IPv6 src=${formatIPv6Address(data.slice(8, 24))}, dst=${formatIPv6Address(data.slice(24, 40))}`);
                    } else {
                        log.debug(`TUN → Device: ${data.length} bytes (too small for IPv6 header)`);
                    }

                    if (!deviceConn.destroyed) {
                        deviceConn.write(data);
                    }
                }
            } catch (err: any) {
                if (!this.cancelled) {
                    log.error('Error reading from TUN:', err.message);
                }
            }
        }, 5); // Poll every 5ms
    }

    async stop(): Promise<void> {
        // Prevent multiple concurrent stops
        if (this.cleanupPromise) {
            return this.cleanupPromise;
        }

        this.cleanupPromise = this._performStop();
        return this.cleanupPromise;
    }

    private async _performStop(): Promise<void> {
        const tunName = this.tun ? this.tun.name : 'unknown';
        log.debug(`Stopping tunnel manager for ${tunName}`);

        // Signal cancellation
        this.cancelled = true;

        // Clear read interval
        if (this.readInterval) {
            clearInterval(this.readInterval);
            this.readInterval = null;
        }

        // Close device connection if exists
        if (this.deviceConn && !this.deviceConn.destroyed) {
            this.deviceConn.destroy();
            this.deviceConn = null;
        }

        // Clear buffer
        this.buffer = Buffer.alloc(0);

        // Clear packet consumers
        this.packetConsumers.clear();

        // Remove all listeners
        this.removeAllListeners();

        // Close TUN device
        if (this.tun) {
            try {
                this.tun.close();
            } catch (err) {
                log.error('Error closing TUN device:', err);
            }
            this.tun = null;
        }

        // Unregister from active managers
        activeTunnelManagers.delete(this);

        log.debug(`Tunnel for ${tunName} closed successfully`);
    }
}

function formatIPv6Address(buffer: Buffer): string {
    if (!buffer || buffer.length !== 16) {
        return 'invalid-address';
    }
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
        parts.push(buffer.readUInt16BE(i).toString(16));
    }
    return parts.join(':');
}

export async function exchangeCoreTunnelParameters(socket: Socket): Promise<TunnelInfo> {
    return new Promise((resolve, reject) => {
        const request = {
            type: 'clientHandshakeRequest',
            mtu: 16000
        };
        const requestJSON = JSON.stringify(request);
        const jsonBuffer = Buffer.from(requestJSON);
        const magic = Buffer.from('CDTunnel');
        const length = Buffer.alloc(2);
        length.writeUInt16BE(jsonBuffer.length);

        const message = Buffer.concat([magic, length, jsonBuffer]);

        log.debug(`Sending CDTunnel packet: magic=${magic.toString()}, length=${jsonBuffer.length}, body=${requestJSON}`);

        socket.write(message);

        // For receiving the response
        let buffer = Buffer.alloc(0);

        function cleanup() {
            socket.removeListener('data', handleData);
            socket.removeListener('error', handleError);
            socket.removeListener('end', handleEnd);
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }

        function handleData(data: Buffer) {
            log.debug('Received data chunk:', data.length, 'bytes');
            buffer = Buffer.concat([buffer, data]);

            if (buffer.length < 10) {return;}

            const receivedMagic = buffer.slice(0, 8).toString();
            if (receivedMagic !== 'CDTunnel') {
                log.error('Invalid magic header:', receivedMagic);
                cleanup();
                return reject(new Error('Invalid packet format'));
            }

            const payloadLength = buffer.readUInt16BE(8);
            const totalLength = 8 + 2 + payloadLength;

            log.debug('Expected total packet length:', totalLength, 'current buffer:', buffer.length);

            if (buffer.length >= totalLength) {
                const payload = buffer.slice(10, totalLength);
                try {
                    const response = JSON.parse(payload.toString());
                    log.debug('Parsed CDTunnel response:', response);
                    cleanup();
                    resolve(response);
                } catch (err) {
                    log.error('Failed to parse JSON:', err);
                    cleanup();
                    reject(new Error('Invalid JSON response'));
                }
            }
        }

        function handleError(err: Error) {
            log.error('Socket error:', err);
            cleanup();
            reject(err);
        }

        function handleEnd() {
            log.debug('Connection ended');
            if (buffer.length > 0) {
                log.debug('Buffer at end:', buffer.toString('hex'));
            }
            cleanup();
            reject(new Error('Connection closed before receiving complete response'));
        }

        // Set a timeout for the handshake
        const timeoutHandle = setTimeout(() => {
            cleanup();
            reject(new Error('Tunnel handshake timeout'));
        }, 30000); // 30 second timeout

        socket.on('data', handleData);
        socket.on('error', handleError);
        socket.on('end', handleEnd);
    });
}

export async function connectToTunnelLockdown(secureServiceSocket: Socket): Promise<TunnelConnection> {
    const tunnelManager = new TunnelManager();

    try {
        // Exchange tunnel parameters with the device
        const tunnelInfo = await exchangeCoreTunnelParameters(secureServiceSocket);
        log.debug('Tunnel parameters exchanged:', tunnelInfo);

        // Setup tunnel interface
        const tunInterfaceInfo = await tunnelManager.setupInterface(tunnelInfo);
        log.debug('Tunnel interface set up:', tunInterfaceInfo.name);

        // Start bidirectional forwarding
        tunnelManager.startForwarding(secureServiceSocket);

        // Create close function
        const closeFunc = async () => {
            log.debug('Closing tunnel connection');
            await tunnelManager.stop();

            if (!secureServiceSocket.destroyed) {
                secureServiceSocket.end();
            }
        };

        return {
            Address: tunnelInfo.serverAddress,
            RsdPort: tunnelInfo.serverRSDPort,
            tunnelManager,
            closer: closeFunc,
            addPacketConsumer: (consumer: PacketConsumer) => tunnelManager.addPacketConsumer(consumer),
            removePacketConsumer: (consumer: PacketConsumer) => tunnelManager.removePacketConsumer(consumer),
            getPacketStream: () => tunnelManager.getPacketStream()
        };
    } catch (err: any) {
        log.error('Failed to connect to tunnel:', err);
        await tunnelManager.stop();
        if (!secureServiceSocket.destroyed) {
            secureServiceSocket.end();
        }
        throw err;
    }
}
