import {Buffer} from 'node:buffer';
import net, {type AddressInfo} from 'node:net';
import tls from 'node:tls';

/**
 * TLS-PSK (or silent TCP) peer for the TunnelForwarder specs. Runs in a child
 * process; PEER_MODE picks the behavior, PEER_RESET_MS the delay before a reset,
 * PEER_UDP_PORT the in-tunnel port the frame-sending modes answer on. Prints the port.
 */

const mode = process.env.PEER_MODE;
const resetMs = Number(process.env.PEER_RESET_MS);
const udpPort = Number(process.env.PEER_UDP_PORT);
const psk = Buffer.alloc(32, 0x42);
const IPV6_HEADER_SIZE = 40;
const UDP_HEADER_SIZE = 8;
const UDP_PROTOCOL = 17;
const FRAME_RESEND_MS = 250;
const SERVER_ADDRESS = 'fd00::1';
// Not used by any other spec: spec files run in parallel, and Windows refuses
// to put one IPv6 address on two adapters.
const CLIENT_ADDRESS = 'fd00::12';

/** Expands an IPv6 address with at most one `::` into its 16 bytes. */
function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = Array<string>(8 - headGroups.length - tailGroups.length).fill('0');
  const out = Buffer.alloc(16);
  [...headGroups, ...fill, ...tailGroups].forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

/** Internet checksum (RFC 1071) over `data`, odd trailing byte zero-padded. */
function internetChecksum(data: Buffer): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) {
    sum += (data[i] << 8) | (i + 1 < data.length ? data[i + 1] : 0);
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return ~sum & 0xffff;
}

/** Builds a checksummed IPv6/UDP packet carrying `payload`. */
function ipv6UdpFrame(
  source: Buffer,
  destination: Buffer,
  sourcePort: number,
  destinationPort: number,
  payload: Buffer,
): Buffer {
  const udpLength = UDP_HEADER_SIZE + payload.length;
  const udp = Buffer.alloc(udpLength);
  udp.writeUInt16BE(sourcePort, 0);
  udp.writeUInt16BE(destinationPort, 2);
  udp.writeUInt16BE(udpLength, 4);
  payload.copy(udp, UDP_HEADER_SIZE);
  const pseudoHeader = Buffer.alloc(40);
  source.copy(pseudoHeader, 0);
  destination.copy(pseudoHeader, 16);
  pseudoHeader.writeUInt32BE(udpLength, 32);
  pseudoHeader[39] = UDP_PROTOCOL;
  udp.writeUInt16BE(internetChecksum(Buffer.concat([pseudoHeader, udp])) || 0xffff, 6);
  const header = Buffer.alloc(IPV6_HEADER_SIZE);
  header[0] = 0x60;
  header.writeUInt16BE(udpLength, 4);
  header[6] = UDP_PROTOCOL;
  header[7] = 64;
  source.copy(header, 8);
  destination.copy(header, 24);
  return Buffer.concat([header, udp]);
}

/** An IPv6 header claiming a 65535-byte payload that never arrives. */
function bogusHeader(): Buffer {
  const header = Buffer.alloc(IPV6_HEADER_SIZE);
  header[0] = 0x60;
  header.writeUInt16BE(0xffff, 4);
  return header;
}

/** Splits `stream` into complete IPv6 packets, skipping non-IPv6 bytes; returns them and the unparsed tail. */
function splitIpv6Packets(stream: Buffer): {packets: Buffer[]; rest: Buffer} {
  const packets: Buffer[] = [];
  let offset = 0;
  while (stream.length - offset >= IPV6_HEADER_SIZE) {
    if (stream[offset] >> 4 !== 6) {
      offset += 1;
      continue;
    }
    const length = IPV6_HEADER_SIZE + stream.readUInt16BE(offset + 4);
    if (stream.length - offset < length) {
      break;
    }
    packets.push(stream.subarray(offset, offset + length));
    offset += length;
  }
  return {packets, rest: stream.subarray(offset)};
}

/** True for a host UDP datagram addressed to the peer's in-tunnel address and port. */
function isDatagramToPeer(packet: Buffer): boolean {
  return (
    packet.length >= IPV6_HEADER_SIZE + UDP_HEADER_SIZE &&
    packet[6] === UDP_PROTOCOL &&
    packet.subarray(24, 40).equals(ipv6Bytes(SERVER_ADDRESS)) &&
    packet.readUInt16BE(IPV6_HEADER_SIZE + 2) === udpPort
  );
}

/**
 * Waits for the host's datagram to the peer, then repeats `prefix` followed by
 * three valid reply frames until the socket closes. Replying, as a device does,
 * keeps the frames acceptable to a host firewall that drops unsolicited inbound.
 */
function replyWithFrameBursts(socket: tls.TLSSocket, prefix: Buffer): void {
  let pending: Buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    const {packets, rest} = splitIpv6Packets(Buffer.concat([pending, chunk]));
    pending = rest;
    const datagram = packets.find(isDatagramToPeer);
    if (!datagram) {
      return;
    }
    socket.off('data', onData);
    const host = datagram.subarray(8, 24);
    const hostPort = datagram.readUInt16BE(IPV6_HEADER_SIZE);
    const peer = datagram.subarray(24, 40);
    const frames = [0, 1, 2].map((i) => ipv6UdpFrame(peer, host, udpPort, hostPort, Buffer.from(`frame-${i}`)));
    const burst = Buffer.concat([prefix, ...frames]);
    socket.write(burst);
    const resend = setInterval(() => socket.write(burst), FRAME_RESEND_MS);
    socket.once('close', () => clearInterval(resend));
  };
  socket.on('data', onData);
}

function frame(bodyLength: number, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write('CDTunnel', 0, 'ascii');
  header.writeUInt16BE(bodyLength, 8);
  return Buffer.concat([header, body]);
}

const handshakeBody = Buffer.from(
  JSON.stringify({
    clientParameters: {address: CLIENT_ADDRESS, mtu: 1280},
    serverAddress: SERVER_ADDRESS,
    serverRSDPort: 1234,
  }),
);

function createSilentTcpServer(): net.Server {
  return net.createServer((socket) => {
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), resetMs);
  });
}

function createPskServer(): tls.Server {
  const options: tls.TlsOptions = {
    pskCallback: (_socket, identity) => (identity === 'Client_identity' ? psk : null),
    ciphers: 'PSK-AES256-CBC-SHA:@SECLEVEL=0',
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  };
  return tls.createServer(options, (socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      if (mode === 'handshake-stall') {
        socket.write(frame(0xffff, Buffer.from('{')));
        setTimeout(() => socket.destroy(), resetMs);
      } else {
        socket.write(frame(handshakeBody.length, handshakeBody));
        if (mode === 'garbage-then-frames') {
          replyWithFrameBursts(socket, bogusHeader());
        } else if (mode === 'frames-only') {
          replyWithFrameBursts(socket, Buffer.alloc(0));
        }
      }
    });
  });
}

const server = mode === 'silent-tcp' ? createSilentTcpServer() : createPskServer();
server.listen(0, '127.0.0.1', () => {
  const {port} = server.address() as AddressInfo;
  process.stdout.write(String(port));
});
