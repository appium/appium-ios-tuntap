import {log} from '../logger.js';
import {TunTap} from '../TunTap.js';
import {EventEmitter} from 'node:events';
import type {Socket} from 'node:net';
import {Buffer} from 'node:buffer';

import {
  CD_TUNNEL_HANDSHAKE_TIMEOUT_MS,
  CD_TUNNEL_HEADER_SIZE,
  CD_TUNNEL_MAGIC,
  CD_TUNNEL_MAGIC_SIZE,
  CD_TUNNEL_MTU,
  DEFAULT_TUN_POLL_QUEUE_DEPTH,
  FAST_TUN_POLL_QUEUE_DEPTH,
  IPV6_HEADER_SIZE,
  LARGE_TUN_POLL_BUFFER,
  MAX_DEVICE_INGRESS_BUFFER,
  MAX_TUN_POLL_BUFFER,
  IPV6_VERSION,
  IPPROTO_TCP,
  IPPROTO_UDP,
} from './constants.js';
import {appendBuffer} from './buffer-utils.js';
import type {
  CdTunnelParseResult,
  Ipv6Frame,
  PacketConsumer,
  PacketData,
  TunnelConnection,
  TunnelInfo,
  TunnelManagerEvents,
} from './types.js';

/**
 * Bridges a CoreDevice tunnel `Socket` and a {@link TunTap} interface: IPv6 framing, TUN I/O, and packet fan-out.
 * Emits {@link TunnelManagerEvents} (currently `data` with {@link PacketData}) for TCP/UDP packets, same as registered consumers.
 */
export class TunnelManager extends EventEmitter<TunnelManagerEvents> {
  private tun: TunTap | null = null;
  private cancelled: boolean = false;
  private mtu: number = CD_TUNNEL_MTU;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly packetConsumers: Set<PacketConsumer> = new Set();
  private deviceConn: Socket | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private tunReadPausedForBackpressure = false;
  private deviceIngressPausedForTun = false;
  private drainingDeviceToTun = false;

  /**
   * Register a listener for parsed tunnel packets (in addition to the `data` event).
   *
   * @param consumer — object with {@link PacketConsumer.onPacket}
   */
  addPacketConsumer(consumer: PacketConsumer): void {
    this.packetConsumers.add(consumer);
  }

  /**
   * Unregister a consumer previously added with {@link TunnelManager.addPacketConsumer}.
   *
   * @param consumer — same reference as passed to `addPacketConsumer`
   */
  removePacketConsumer(consumer: PacketConsumer): void {
    this.packetConsumers.delete(consumer);
  }

  /**
   * Async iterator over tunnel packets until {@link TunnelManager.stop} sets `cancelled`.
   *
   * @yields {@link PacketData} for each TCP/UDP packet
   */
  async *getPacketStream(): AsyncIterable<PacketData> {
    const queue: PacketData[] = [];
    let resolver: ((value: IteratorResult<PacketData>) => void) | null = null;

    const consumer: PacketConsumer = {
      onPacket: (packet) => {
        if (resolver) {
          resolver({value: packet, done: false});
          resolver = null;
        } else {
          queue.push(packet);
        }
      },
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

  /**
   * Open a {@link TunTap}, assign the client IPv6 address/MTU, and add a /128 route to the server.
   *
   * @param tunnelInfo — handshake result (client address, MTU, server address)
   * @returns interface name, MTU, and the live {@link TunTap} instance
   */
  async setupInterface(
    tunnelInfo: TunnelInfo,
  ): Promise<{name: string; mtu: number; interface: TunTap}> {
    log.debug(`Setting up tunnel with parameters:`, tunnelInfo);

    try {
      this.tun = new TunTap();

      // Open the TUN device
      if (!this.tun.open()) {
        throw new Error('Failed to open TUN device');
      }

      log.debug(`Opened TUN device: ${this.tun.name}`);

      this.mtu = tunnelInfo.clientParameters.mtu;

      // Configure the TUN device with IPv6 address and MTU
      await this.tun.configure(
        tunnelInfo.clientParameters.address,
        tunnelInfo.clientParameters.mtu,
      );

      // Add route for the server address
      await this.tun.addRoute(`${tunnelInfo.serverAddress}/128`);

      log.debug(
        `Configured TUN interface ${this.tun.name} with address ${tunnelInfo.clientParameters.address} and MTU ${tunnelInfo.clientParameters.mtu}`,
      );

      return {
        name: this.tun.name,
        mtu: tunnelInfo.clientParameters.mtu,
        interface: this.tun,
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

  /**
   * Begin bidirectional forwarding: device socket ↔ TUN (requires {@link TunnelManager.setupInterface} first).
   *
   * @param deviceConn — connected tunnel socket after the CDTunnel handshake
   */
  startForwarding(deviceConn: Socket): void {
    if (!this.tun) {
      log.error('TUN device is not set up');
      return;
    }

    this.deviceConn = deviceConn;
    log.debug(`Starting bidirectional data forwarding for ${this.tun.name}`);

    deviceConn.setNoDelay(true);
    deviceConn.setKeepAlive(true, 1000);

    // Handle data from the device connection
    deviceConn.on('data', (data: Buffer) => {
      if (this.cancelled) {
        return;
      }

      try {
        this.buffer = appendBuffer(this.buffer, data);

        if (this.buffer.length > MAX_DEVICE_INGRESS_BUFFER) {
          this.pauseDeviceIngress();
        }

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

  /**
   * Idempotent shutdown: stop polling, destroy the socket, clear consumers, close the TUN device.
   *
   * @returns the same promise if already stopping/stopped
   */
  async stop(): Promise<void> {
    // Prevent multiple concurrent stops
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = this._performStop();
    return this.cleanupPromise;
  }

  private hasPacketTap(): boolean {
    return this.packetConsumers.size > 0 || this.listenerCount('data') > 0;
  }

  private processBuffer(): void {
    let offset = 0;

    while (offset + IPV6_HEADER_SIZE <= this.buffer.length) {
      const frame = nextIpv6Frame(this.buffer, offset);
      if (frame.kind === 'incomplete') {
        break;
      }
      if (frame.kind === 'resync') {
        offset++;
        continue;
      }

      if (!this.tun) {
        log.error('TUN device is null during packet processing');
        break;
      }

      const writeResult = this.writeDeviceFrameToTun(
        this.tun,
        frame.packet,
        frame.nextHeader,
      );
      if (writeResult === 'blocked') {
        this.pauseDeviceIngress();
        this.scheduleDrainDeviceToTun();
        break;
      }

      offset += frame.length;
    }

    if (offset > 0) {
      if (offset >= this.buffer.length) {
        this.buffer = Buffer.alloc(0);
      } else {
        this.buffer = this.buffer.subarray(offset);
      }
    }

    if (this.buffer.length === 0 && this.deviceIngressPausedForTun) {
      this.resumeDeviceIngress();
    }
  }

  private writeDeviceFrameToTun(
    tun: TunTap,
    packet: Buffer,
    nextHeader: number,
  ): 'ok' | 'blocked' {
    let offset = 0;
    while (offset < packet.length) {
      const written = tun.write(packet.subarray(offset));
      if (written <= 0) {
        return 'blocked';
      }
      offset += written;
    }

    if (this.hasPacketTap()) {
      const {src, dst} = ipv6Endpoints(packet);
      log.debug(`Device → TUN: ${packet.length} bytes, IPv6 src=${src}, dst=${dst}`);
      this.tapL4Packet(packet, nextHeader, src, dst);
    }

    return 'ok';
  }

  private pauseDeviceIngress(): void {
    if (this.deviceIngressPausedForTun || !this.deviceConn || this.deviceConn.destroyed) {
      return;
    }
    this.deviceIngressPausedForTun = true;
    this.deviceConn.pause();
  }

  private resumeDeviceIngress(): void {
    if (!this.deviceIngressPausedForTun || !this.deviceConn || this.deviceConn.destroyed) {
      return;
    }
    this.deviceIngressPausedForTun = false;
    this.deviceConn.resume();
  }

  private scheduleDrainDeviceToTun(): void {
    if (this.drainingDeviceToTun || this.cancelled) {
      return;
    }
    this.drainingDeviceToTun = true;
    setImmediate(() => {
      this.drainingDeviceToTun = false;
      if (this.cancelled) {
        return;
      }
      try {
        this.processBuffer();
      } catch (err: any) {
        if (!this.cancelled) {
          log.error('Error draining device ingress buffer:', err.message);
        }
      }
    });
  }

  private tapL4Packet(packet: Buffer, nextHeader: number, src: string, dst: string): void {
    let packetData: PacketData | null = null;

    if (nextHeader === IPPROTO_UDP) {
      packetData = parseUdpPacketData(packet, src, dst);
      if (!packetData) {
        log.debug('UDP payload too short, not emitting event.');
      } else {
        log.debug(`UDP packet detected: payload length=${packetData.payload.length}`);
      }
    } else if (nextHeader === IPPROTO_TCP) {
      packetData = parseTcpPacketData(packet, src, dst);
      if (!packetData) {
        log.debug('TCP packet too short or malformed, skipping.');
      } else {
        log.debug(`TCP packet detected: payload length=${packetData.payload.length}`);
      }
    } else {
      log.debug('Packet is not UDP or TCP (nextHeader !== 17 and !== 6)');
    }

    if (packetData) {
      this.dispatchPacketData(packetData);
    }
  }

  private dispatchPacketData(packetData: PacketData): void {
    this.emit('data', packetData);
    for (const consumer of this.packetConsumers) {
      try {
        consumer.onPacket(packetData);
      } catch (err) {
        log.error('Error in packet consumer:', err);
      }
    }
    log.debug(`Emitted data event for ${packetData.protocol} packet`);
  }

  private startTunReadLoop(deviceConn: Socket): void {
    if (!this.tun) {
      return;
    }

    const tapOn = this.hasPacketTap();
    const pollBuffer = tapOn
      ? this.mtu
      : Math.min(MAX_TUN_POLL_BUFFER, Math.max(this.mtu, LARGE_TUN_POLL_BUFFER));
    const queueDepth = tapOn ? DEFAULT_TUN_POLL_QUEUE_DEPTH : FAST_TUN_POLL_QUEUE_DEPTH;

    this.tun.startPolling(
      (data: Buffer) => {
        if (this.cancelled || !data.length || deviceConn.destroyed) {
          return;
        }

        if (tapOn && data.length >= IPV6_HEADER_SIZE) {
          log.debug(
            `TUN → Device: ${data.length} bytes, IPv6 src=${formatIPv6Address(data.subarray(8, 24))}, dst=${formatIPv6Address(data.subarray(24, 40))}`,
          );
        } else if (tapOn) {
          log.debug(`TUN → Device: ${data.length} bytes (too small for IPv6 header)`);
        }

        this.writeTunPacketToDevice(deviceConn, data);
      },
      pollBuffer,
      queueDepth,
    );
  }

  private writeTunPacketToDevice(deviceConn: Socket, data: Buffer): void {
    if (deviceConn.destroyed) {
      return;
    }

    const canWriteMore = deviceConn.write(data);
    if (canWriteMore || this.tunReadPausedForBackpressure || !this.tun) {
      return;
    }

    this.tunReadPausedForBackpressure = true;
    this.tun.pausePolling();

    const onDrain = (): void => {
      if (this.cancelled || deviceConn.destroyed) {
        return;
      }
      this.tunReadPausedForBackpressure = false;
      this.tun?.resumePolling();
    };

    deviceConn.once('drain', onDrain);
  }

  private async _performStop(): Promise<void> {
    const tunName = this.tun ? this.tun.name : 'unknown';
    log.debug(`Stopping tunnel manager for ${tunName}`);

    // Signal cancellation
    this.cancelled = true;

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

    log.debug(`Tunnel for ${tunName} closed successfully`);
  }
}

/**
 * Perform the CDTunnel JSON handshake (8-byte magic + length-prefixed JSON) over `socket`.
 *
 * @param socket — connected stream to the tunnel service
 * @returns parsed tunnel parameters from the device response
 */
export async function exchangeCoreTunnelParameters(socket: Socket): Promise<TunnelInfo> {
  const requestJson = JSON.stringify({
    type: 'clientHandshakeRequest',
    mtu: CD_TUNNEL_MTU,
  });
  const message = encodeCdTunnelMessage(requestJson);

  log.debug(
    `Sending CDTunnel packet: magic=${CD_TUNNEL_MAGIC}, length=${message.length - CD_TUNNEL_HEADER_SIZE}, body=${requestJson}`,
  );

  socket.write(message);
  return readCdTunnelResponse(socket, CD_TUNNEL_HANDSHAKE_TIMEOUT_MS);
}

/**
 * End-to-end setup: handshake, TUN configuration, route, and forwarding on `secureServiceSocket`.
 *
 * @param secureServiceSocket — tunnel socket (e.g. from lockdown secure service)
 * @returns connection handle with {@link TunnelConnection.closer} and packet APIs
 */
export async function connectToTunnelLockdown(
  secureServiceSocket: Socket,
): Promise<TunnelConnection> {
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
      removePacketConsumer: (consumer: PacketConsumer) =>
        tunnelManager.removePacketConsumer(consumer),
      getPacketStream: () => tunnelManager.getPacketStream(),
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

function encodeCdTunnelMessage(json: string): Buffer {
  const body = Buffer.from(json);
  const header = Buffer.alloc(CD_TUNNEL_HEADER_SIZE);
  header.write(CD_TUNNEL_MAGIC, 0, CD_TUNNEL_MAGIC_SIZE, 'ascii');
  header.writeUInt16BE(body.length, CD_TUNNEL_MAGIC_SIZE);
  return Buffer.concat([header, body]);
}

function tryParseCdTunnelResponse(buffer: Buffer): CdTunnelParseResult {
  if (buffer.length < CD_TUNNEL_HEADER_SIZE) {
    return {kind: 'incomplete'};
  }

  const magic = buffer.subarray(0, CD_TUNNEL_MAGIC_SIZE).toString();
  if (magic !== CD_TUNNEL_MAGIC) {
    log.error('Invalid magic header:', magic);
    return {kind: 'error', error: new Error('Invalid packet format')};
  }

  const payloadLength = buffer.readUInt16BE(CD_TUNNEL_MAGIC_SIZE);
  const totalLength = CD_TUNNEL_HEADER_SIZE + payloadLength;
  if (buffer.length < totalLength) {
    return {kind: 'incomplete'};
  }

  try {
    const value = JSON.parse(
      buffer.subarray(CD_TUNNEL_HEADER_SIZE, totalLength).toString(),
    ) as TunnelInfo;
    return {kind: 'ok', value};
  } catch (err) {
    log.error('Failed to parse JSON:', err);
    return {kind: 'error', error: new Error('Invalid JSON response')};
  }
}

function readCdTunnelResponse(socket: Socket, timeoutMs: number): Promise<TunnelInfo> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      clearTimeout(timeoutHandle);
    };

    const finish = (action: () => void) => {
      cleanup();
      action();
    };

    const onData = (chunk: Buffer) => {
      log.debug('Received data chunk:', chunk.length, 'bytes');
      buffer = appendBuffer(buffer, chunk);

      if (buffer.length >= CD_TUNNEL_HEADER_SIZE) {
        const payloadLength = buffer.readUInt16BE(CD_TUNNEL_MAGIC_SIZE);
        log.debug(
          'Expected total packet length:',
          CD_TUNNEL_HEADER_SIZE + payloadLength,
          'current buffer:',
          buffer.length,
        );
      }

      const result = tryParseCdTunnelResponse(buffer);
      if (result.kind === 'incomplete') {
        return;
      }
      if (result.kind === 'error') {
        finish(() => reject(result.error));
        return;
      }

      log.debug('Parsed CDTunnel response:', result.value);
      finish(() => resolve(result.value));
    };

    const onError = (err: Error) => {
      log.error('Socket error:', err);
      finish(() => reject(err));
    };

    const onEnd = () => {
      log.debug('Connection ended');
      if (buffer.length > 0) {
        log.debug('Buffer at end:', buffer.toString('hex'));
      }
      finish(() => reject(new Error('Connection closed before receiving complete response')));
    };

    const timeoutHandle = setTimeout(() => {
      finish(() => reject(new Error('Tunnel handshake timeout')));
    }, timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function nextIpv6Frame(buffer: Buffer, offset: number): Ipv6Frame {
  if (offset + IPV6_HEADER_SIZE > buffer.length) {
    return {kind: 'incomplete'};
  }

  const header = buffer.subarray(offset, offset + IPV6_HEADER_SIZE);
  if (((header[0] >> 4) & 0x0f) !== IPV6_VERSION) {
    return {kind: 'resync'};
  }

  const payloadLength = header.readUInt16BE(4);
  const length = IPV6_HEADER_SIZE + payloadLength;
  if (offset + length > buffer.length) {
    return {kind: 'incomplete'};
  }

  return {
    kind: 'frame',
    packet: buffer.subarray(offset, offset + length),
    nextHeader: header[6],
    length,
  };
}

function ipv6Endpoints(packet: Buffer): {src: string; dst: string} {
  return {
    src: formatIPv6Address(packet.subarray(8, 24)),
    dst: formatIPv6Address(packet.subarray(24, 40)),
  };
}

function parseUdpPacketData(packet: Buffer, src: string, dst: string): PacketData | null {
  const payload = packet.subarray(IPV6_HEADER_SIZE);
  if (payload.length < 8) {
    return null;
  }
  return {
    protocol: 'UDP',
    src,
    dst,
    sourcePort: payload.readUInt16BE(0),
    destPort: payload.readUInt16BE(2),
    payload: payload.subarray(8),
  };
}

function parseTcpPacketData(packet: Buffer, src: string, dst: string): PacketData | null {
  const tcpStart = IPV6_HEADER_SIZE;
  if (packet.length < tcpStart + 20) {
    return null;
  }

  const tcpHeaderLength = (packet.readUInt8(tcpStart + 12) >> 4) * 4;
  if (packet.length < tcpStart + tcpHeaderLength) {
    return null;
  }

  return {
    protocol: 'TCP',
    src,
    dst,
    sourcePort: packet.readUInt16BE(tcpStart),
    destPort: packet.readUInt16BE(tcpStart + 2),
    payload: packet.subarray(tcpStart + tcpHeaderLength),
  };
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
