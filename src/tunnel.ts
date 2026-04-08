import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';

import { log } from './logger.js';
import { TunTap } from './TunTap.js';

// Protocol constants
const IPV6_HEADER_SIZE = 40;
const CDTUNNEL_MAGIC = 'CDTunnel';
const CDTUNNEL_HEADER_SIZE = 10; // 8 (magic) + 2 (length)

// Limits
const MAX_PACKET_QUEUE_SIZE = 10_000;
const MAX_HANDSHAKE_RESPONSE_SIZE = 8_192; // Practical limit for CDTunnel JSON response
const HANDSHAKE_TIMEOUT_MS = 30_000;

// IPv6 next-header protocol numbers
const NEXT_HEADER_TCP = 6;
const NEXT_HEADER_UDP = 17;
const MIN_TCP_HEADER_SIZE = 20;
const MIN_UDP_HEADER_SIZE = 8;

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

export class TunnelManager extends EventEmitter {
    private tun: TunTap | null;
    private cancelled: boolean;
    private pendingChunks: Buffer[];
    private pendingLength: number;
    private buffer: Buffer;
    private packetConsumers: Set<PacketConsumer>;
    private deviceConn: Socket | null;
    private cleanupPromise: Promise<void> | null;

    constructor() {
        super();
        this.tun = null;
        this.cancelled = false;
        this.pendingChunks = [];
        this.pendingLength = 0;
        this.buffer = Buffer.alloc(0);
        this.packetConsumers = new Set();
        this.deviceConn = null;
        this.cleanupPromise = null;
    }

    addPacketConsumer(consumer: PacketConsumer): void {
        this.packetConsumers.add(consumer);
    }

    removePacketConsumer(consumer: PacketConsumer): void {
        this.packetConsumers.delete(consumer);
    }

    async *getPacketStream(): AsyncIterable<PacketData> {
        const queue: PacketData[] = [];
        let resolver: ((packet: PacketData | null) => void) | null = null;
        let done = false;

        const consumer: PacketConsumer = {
            onPacket: (packet: PacketData) => {
                if (done) {return;}
                if (resolver) {
                    const r = resolver;
                    resolver = null;
                    r(packet);
                } else if (queue.length < MAX_PACKET_QUEUE_SIZE) {
                    queue.push(packet);
                } else {
                    // Drop oldest to make room (bounded queue)
                    log.warn('Packet queue full, dropping oldest packet');
                    queue.shift();
                    queue.push(packet);
                }
            }
        };

        const onStopped = () => {
            done = true;
            if (resolver) {
                const r = resolver;
                resolver = null;
                r(null);
            }
        };

        this.addPacketConsumer(consumer);
        this.once('stopped', onStopped);

        try {
            while (!this.cancelled && !done) {
                if (queue.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    yield queue.shift()!;
                } else {
                    const packet = await new Promise<PacketData | null>((resolve) => {
                        if (this.cancelled || done) {
                            resolve(null);
                            return;
                        }
                        resolver = resolve;
                    });
                    if (packet === null) {break;}
                    yield packet;
                }
            }
        } finally {
            done = true;
            resolver = null;
            this.removePacketConsumer(consumer);
            this.removeListener('stopped', onStopped);
        }
    }

    async setupInterface(tunnelInfo: TunnelInfo): Promise<{ name: string; mtu: number; interface: TunTap }> {
        log.debug('Setting up tunnel with parameters:', tunnelInfo);

        try {
            this.tun = new TunTap();

            if (!this.tun.open()) {
                throw new Error('Failed to open TUN device');
            }

            log.debug(`Opened TUN device: ${this.tun.name}`);

            await this.tun.configure(tunnelInfo.clientParameters.address, tunnelInfo.clientParameters.mtu);
            await this.tun.addRoute(`${tunnelInfo.serverAddress}/128`);

            log.debug(
                `Configured TUN interface ${this.tun.name} with ` +
                `address ${tunnelInfo.clientParameters.address} and MTU ${tunnelInfo.clientParameters.mtu}`
            );

            return {
                name: this.tun.name,
                mtu: tunnelInfo.clientParameters.mtu,
                interface: this.tun
            };
        } catch (err: unknown) {
            log.error(`Error setting up TUN interface: ${(err as Error).message}`);
            if (this.tun) {
                try { this.tun.close(); } catch (closeErr: unknown) {
                    log.error('Error closing TUN device:', (closeErr as Error).message);
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

        // Socket → TUN: incoming device data
        deviceConn.on('data', (data: Buffer) => {
            if (this.cancelled) {return;}
            try {
                this.pendingChunks.push(data);
                this.pendingLength += data.length;
                this.processBuffer();
            } catch (err: unknown) {
                if (!this.cancelled) {
                    log.error('Error processing device data:', (err as Error).message);
                }
            }
        });

        // TUN → Socket: event-driven reading via native libuv poll
        this.tun.startPolling((data: Buffer) => {
            if (this.cancelled || !deviceConn || deviceConn.destroyed) {return;}
            try {
                if (data.length >= IPV6_HEADER_SIZE) {
                    log.debug(
                        `TUN → Device: ${data.length} bytes, ` +
                        `IPv6 src=${formatIPv6Address(data.subarray(8, 24))}, ` +
                        `dst=${formatIPv6Address(data.subarray(24, 40))}`
                    );
                } else {
                    log.debug(`TUN → Device: ${data.length} bytes (too small for IPv6 header)`);
                }
                deviceConn.write(data);
            } catch (err: unknown) {
                if (!this.cancelled) {
                    log.error('Error writing to device connection:', (err as Error).message);
                }
            }
        });

        deviceConn.on('close', async () => {
            log.debug('Device connection closed, stopping tunnel');
            try { await this.stop(); } catch (err) {
                log.error('Error stopping tunnel:', err);
            }
        });

        deviceConn.on('error', (err: Error) => {
            log.error('Device connection error:', err);
        });
    }

    private processBuffer(): void {
        // Merge pending chunks with existing leftover buffer
        if (this.pendingChunks.length > 0) {
            const chunks = this.buffer.length > 0
                ? [this.buffer, ...this.pendingChunks]
                : this.pendingChunks;
            const totalLength = this.buffer.length + this.pendingLength;
            this.buffer = Buffer.concat(chunks, totalLength);
            this.pendingChunks = [];
            this.pendingLength = 0;
        }

        let offset = 0;
        const bufferLength = this.buffer.length;

        while (offset + IPV6_HEADER_SIZE <= bufferLength) {
            const version = (this.buffer[offset] >> 4) & 0x0f;
            if (version !== 6) {
                // Corrupted data — scan forward for next potential IPv6 header
                log.warn(`Non-IPv6 data at offset ${offset}, scanning for next valid header`);
                offset++;
                while (offset + IPV6_HEADER_SIZE <= bufferLength && (this.buffer[offset] >> 4) !== 6) {
                    offset++;
                }
                continue;
            }

            const payloadLength = this.buffer.readUInt16BE(offset + 4);
            const packetLength = IPV6_HEADER_SIZE + payloadLength;

            if (offset + packetLength > bufferLength) {
                break; // Incomplete packet — wait for more data
            }

            const packet = this.buffer.subarray(offset, offset + packetLength);
            const src = formatIPv6Address(packet.subarray(8, 24));
            const dst = formatIPv6Address(packet.subarray(24, 40));
            const nextHeader = this.buffer[offset + 6];

            log.debug(`Processing packet: nextHeader=${nextHeader}, totalLength=${packetLength}`);

            try {
                if (!this.tun) {
                    log.error('TUN device is null during packet processing');
                    break;
                }

                const bytesWritten = this.tun.write(Buffer.from(packet));
                log.debug(`Device → TUN: ${bytesWritten} bytes, IPv6 src=${src}, dst=${dst}`);

                this.dispatchPacket(packet, nextHeader, src, dst);
            } catch (err: unknown) {
                log.error(`Error writing to TUN: ${(err as Error).message}`);
            }

            offset += packetLength;
        }

        // Copy remaining data to free the original large buffer
        if (offset > 0) {
            this.buffer = offset < bufferLength
                ? Buffer.from(this.buffer.subarray(offset))
                : Buffer.alloc(0);
        }
    }

    private dispatchPacket(packet: Buffer, nextHeader: number, src: string, dst: string): void {
        const packetData = this.parseTransportPacket(packet, nextHeader, src, dst);
        if (!packetData) {return;}

        this.emit('data', packetData);
        for (const consumer of this.packetConsumers) {
            try {
                consumer.onPacket(packetData);
            } catch (err: unknown) {
                log.error('Error in packet consumer:', (err as Error).message);
            }
        }
        log.debug(`Emitted data event for ${packetData.protocol} packet`);
    }

    private parseTransportPacket(
        packet: Buffer, nextHeader: number, src: string, dst: string,
    ): PacketData | null {
        if (nextHeader === NEXT_HEADER_UDP) {
            const payload = packet.subarray(IPV6_HEADER_SIZE);
            if (payload.length < MIN_UDP_HEADER_SIZE) {
                log.debug('UDP payload too short, skipping');
                return null;
            }
            return {
                protocol: 'UDP',
                src,
                dst,
                sourcePort: payload.readUInt16BE(0),
                destPort: payload.readUInt16BE(2),
                payload: Buffer.from(payload.subarray(MIN_UDP_HEADER_SIZE)),
            };
        }

        if (nextHeader === NEXT_HEADER_TCP) {
            if (packet.length < IPV6_HEADER_SIZE + MIN_TCP_HEADER_SIZE) {
                log.debug('TCP packet too short for minimum header, skipping');
                return null;
            }
            const dataOffsetByte = packet.readUInt8(IPV6_HEADER_SIZE + 12);
            const tcpHeaderLength = (dataOffsetByte >> 4) * 4;
            if (packet.length < IPV6_HEADER_SIZE + tcpHeaderLength) {
                log.debug('TCP header length exceeds packet length, skipping');
                return null;
            }
            return {
                protocol: 'TCP',
                src,
                dst,
                sourcePort: packet.readUInt16BE(IPV6_HEADER_SIZE),
                destPort: packet.readUInt16BE(IPV6_HEADER_SIZE + 2),
                payload: Buffer.from(packet.subarray(IPV6_HEADER_SIZE + tcpHeaderLength)),
            };
        }

        log.debug(`Packet with unsupported next header: ${nextHeader}`);
        return null;
    }

    async stop(): Promise<void> {
        if (this.cleanupPromise) {
            return this.cleanupPromise;
        }
        this.cleanupPromise = this._performStop();
        return this.cleanupPromise;
    }

    private async _performStop(): Promise<void> {
        const tunName = this.tun?.name;
        log.debug(`Stopping tunnel manager${tunName ? ` for ${tunName}` : ''}`);

        this.cancelled = true;

        // Signal pending getPacketStream consumers before clearing
        this.emit('stopped');

        // Close device connection
        if (this.deviceConn && !this.deviceConn.destroyed) {
            this.deviceConn.destroy();
            this.deviceConn = null;
        }

        // Clear buffers
        this.buffer = Buffer.alloc(0);
        this.pendingChunks = [];
        this.pendingLength = 0;

        // Clear packet consumers
        this.packetConsumers.clear();

        // Remove all listeners
        this.removeAllListeners();

        // Close TUN device (also stops native polling via CloseInternal → StopPolling)
        if (this.tun) {
            try { this.tun.close(); } catch (err: unknown) {
                log.error('Error closing TUN device:', (err as Error).message);
            }
            this.tun = null;
        }

        log.debug(`Tunnel${tunName ? ` for ${tunName}` : ''} closed successfully`);
    }
}

/**
 * Formats a 16-byte buffer as a compressed IPv6 address string (RFC 5952).
 */
function formatIPv6Address(buffer: Buffer): string {
    if (!buffer || buffer.length !== 16) {
        return 'invalid-address';
    }

    const groups: number[] = [];
    for (let i = 0; i < 16; i += 2) {
        groups.push(buffer.readUInt16BE(i));
    }

    // Find the longest consecutive run of zero groups for :: compression
    let bestStart = -1;
    let bestLen = 0;
    let runStart = -1;

    for (const [i, group] of groups.entries()) {
        if (group === 0) {
            if (runStart === -1) {runStart = i;}
            const runLen = i - runStart + 1;
            if (runLen > bestLen) {
                bestStart = runStart;
                bestLen = runLen;
            }
        } else {
            runStart = -1;
        }
    }

    // Only compress runs of 2+ zero groups (RFC 5952 §4.2.2)
    if (bestLen < 2) {
        return groups.map((g) => g.toString(16)).join(':');
    }

    const before = groups.slice(0, bestStart).map((g) => g.toString(16));
    const after = groups.slice(bestStart + bestLen).map((g) => g.toString(16));

    if (before.length === 0 && after.length === 0) {return '::';}
    if (before.length === 0) {return `::${after.join(':')}`;}
    if (after.length === 0) {return `${before.join(':')}::`;}
    return `${before.join(':')}::${after.join(':')}`;
}

export async function exchangeCoreTunnelParameters(socket: Socket): Promise<TunnelInfo> {
    return new Promise((resolve, reject) => {
        const request = {
            type: 'clientHandshakeRequest',
            mtu: 16000
        };
        const requestJSON = JSON.stringify(request);
        const jsonBuffer = Buffer.from(requestJSON);
        const magicBuf = Buffer.from(CDTUNNEL_MAGIC);
        const lengthBuf = Buffer.alloc(2);
        lengthBuf.writeUInt16BE(jsonBuffer.length);

        const message = Buffer.concat([magicBuf, lengthBuf, jsonBuffer]);

        log.debug(`Sending CDTunnel packet: magic=${CDTUNNEL_MAGIC}, length=${jsonBuffer.length}, body=${requestJSON}`);

        socket.write(message);

        const chunks: Buffer[] = [];
        let totalLength = 0;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let settled = false;

        function cleanup() {
            socket.removeListener('data', handleData);
            socket.removeListener('error', handleError);
            socket.removeListener('end', handleEnd);
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
        }

        function settle(
            outcome: 'resolve' | 'reject',
            value: TunnelInfo | Error,
        ) {
            if (settled) {return;}
            settled = true;
            cleanup();
            if (outcome === 'resolve') {
                resolve(value as TunnelInfo);
            } else {
                reject(value as Error);
            }
        }

        function handleData(data: Buffer) {
            try {
                log.debug('Received data chunk:', data.length, 'bytes');
                chunks.push(data);
                totalLength += data.length;

                if (totalLength < CDTUNNEL_HEADER_SIZE) {return;}

                const buffer = Buffer.concat(chunks, totalLength);

                const receivedMagic = buffer.subarray(0, 8).toString();
                if (receivedMagic !== CDTUNNEL_MAGIC) {
                    log.error('Invalid magic header:', receivedMagic);
                    settle('reject', new Error('Invalid packet format'));
                    return;
                }

                const payloadLength = buffer.readUInt16BE(8);
                const expectedTotal = CDTUNNEL_HEADER_SIZE + payloadLength;

                // Validate the declared handshake size, not the total bytes buffered.
                // totalLength can exceed expectedTotal when the peer pipelines IPv6
                // tunnel traffic immediately after the handshake response.
                if (expectedTotal > MAX_HANDSHAKE_RESPONSE_SIZE) {
                    settle('reject', new Error('Handshake response exceeds maximum size'));
                    return;
                }

                log.debug('Expected total packet length:', expectedTotal, 'current buffer:', totalLength);

                if (totalLength >= expectedTotal) {
                    const payload = buffer.subarray(CDTUNNEL_HEADER_SIZE, expectedTotal);
                    const parsed = JSON.parse(payload.toString());
                    log.debug('Parsed CDTunnel response:', parsed);

                    // Preserve pipelined bytes (tunnel traffic that arrived in the
                    // same TCP segment) by pushing them back into the socket's
                    // internal readable buffer for startForwarding() to consume.
                    if (totalLength > expectedTotal) {
                        const excess = buffer.subarray(expectedTotal);
                        log.debug(`Preserving ${excess.length} pipelined bytes via unshift`);
                        socket.unshift(excess);
                    }

                    settle('resolve', parsed);
                }
            } catch (err: unknown) {
                const message = err instanceof SyntaxError
                    ? `Invalid JSON response: ${err.message}`
                    : `Unexpected error during handshake: ${(err as Error).message}`;
                log.error(message);
                settle('reject', new Error(message));
            }
        }

        function handleError(err: Error) {
            log.error('Socket error:', err.message);
            settle('reject', err);
        }

        function handleEnd() {
            log.debug('Connection ended');
            settle('reject', new Error('Connection closed before receiving complete response'));
        }

        timeoutHandle = setTimeout(() => {
            settle('reject', new Error('Tunnel handshake timeout'));
        }, HANDSHAKE_TIMEOUT_MS);

        socket.on('data', handleData);
        socket.on('error', handleError);
        socket.on('end', handleEnd);
    });
}

export async function connectToTunnelLockdown(secureServiceSocket: Socket): Promise<TunnelConnection> {
    const tunnelManager = new TunnelManager();

    try {
        const tunnelInfo = await exchangeCoreTunnelParameters(secureServiceSocket);
        log.debug('Tunnel parameters exchanged:', tunnelInfo);

        const tunInterfaceInfo = await tunnelManager.setupInterface(tunnelInfo);
        log.debug('Tunnel interface set up:', tunInterfaceInfo.name);

        tunnelManager.startForwarding(secureServiceSocket);

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
    } catch (err: unknown) {
        log.error('Failed to connect to tunnel:', (err as Error).message);
        await tunnelManager.stop();
        if (!secureServiceSocket.destroyed) {
            secureServiceSocket.end();
        }
        throw err;
    }
}
