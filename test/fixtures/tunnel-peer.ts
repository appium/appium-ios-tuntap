import {Buffer} from 'node:buffer';
import net, {type AddressInfo} from 'node:net';
import tls from 'node:tls';

/**
 * TLS-PSK (or silent TCP) peer for the TunnelForwarder specs. Runs in a child
 * process; PEER_MODE picks the behavior, PEER_RESET_MS the delay before a reset,
 * PEER_UDP_PORT the frame destination for the frame-sending modes. Prints the port.
 */

const mode = process.env.PEER_MODE;
const resetMs = Number(process.env.PEER_RESET_MS);
const udpPort = Number(process.env.PEER_UDP_PORT);
const psk = Buffer.alloc(32, 0x42);
const IPV6_HEADER_SIZE = 40;
const UDP_HEADER_SIZE = 8;
const UDP_PROTOCOL = 17;
const FRAME_RESEND_MS = 250;

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
function ipv6UdpFrame(source: string, destination: string, destinationPort: number, payload: Buffer): Buffer {
  const src = ipv6Bytes(source);
  const dst = ipv6Bytes(destination);
  const udpLength = UDP_HEADER_SIZE + payload.length;
  const udp = Buffer.alloc(udpLength);
  udp.writeUInt16BE(destinationPort, 0);
  udp.writeUInt16BE(destinationPort, 2);
  udp.writeUInt16BE(udpLength, 4);
  payload.copy(udp, UDP_HEADER_SIZE);
  const pseudoHeader = Buffer.alloc(40);
  src.copy(pseudoHeader, 0);
  dst.copy(pseudoHeader, 16);
  pseudoHeader.writeUInt32BE(udpLength, 32);
  pseudoHeader[39] = UDP_PROTOCOL;
  udp.writeUInt16BE(internetChecksum(Buffer.concat([pseudoHeader, udp])) || 0xffff, 6);
  const header = Buffer.alloc(IPV6_HEADER_SIZE);
  header[0] = 0x60;
  header.writeUInt16BE(udpLength, 4);
  header[6] = UDP_PROTOCOL;
  header[7] = 64;
  src.copy(header, 8);
  dst.copy(header, 24);
  return Buffer.concat([header, udp]);
}

/** An IPv6 header claiming a 65535-byte payload that never arrives. */
function bogusHeader(): Buffer {
  const header = Buffer.alloc(IPV6_HEADER_SIZE);
  header[0] = 0x60;
  header.writeUInt16BE(0xffff, 4);
  return header;
}

/** Repeats `prefix` followed by three valid frames until the socket closes. */
function sendFrameBursts(socket: tls.TLSSocket, prefix: Buffer): void {
  const frames = [0, 1, 2].map((i) => ipv6UdpFrame('fd00::1', 'fd00::2', udpPort, Buffer.from(`frame-${i}`)));
  const burst = Buffer.concat([prefix, ...frames]);
  socket.write(burst);
  const resend = setInterval(() => socket.write(burst), FRAME_RESEND_MS);
  socket.once('close', () => clearInterval(resend));
}

function frame(bodyLength: number, body: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write('CDTunnel', 0, 'ascii');
  header.writeUInt16BE(bodyLength, 8);
  return Buffer.concat([header, body]);
}

const handshakeBody = Buffer.from(
  JSON.stringify({
    clientParameters: {address: 'fd00::2', mtu: 1280},
    serverAddress: 'fd00::1',
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
          sendFrameBursts(socket, bogusHeader());
        } else if (mode === 'frames-only') {
          sendFrameBursts(socket, Buffer.alloc(0));
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
