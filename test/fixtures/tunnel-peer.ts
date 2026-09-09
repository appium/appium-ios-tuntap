import {Buffer} from 'node:buffer';
import net, {type AddressInfo} from 'node:net';
import tls from 'node:tls';

/**
 * TLS-PSK (or silent TCP) peer for the TunnelForwarder teardown spec.
 * Runs in a child process; PEER_MODE picks the behavior, PEER_RESET_MS the
 * delay before the peer resets the connection. Prints the listening port.
 */

const mode = process.env.PEER_MODE;
const resetMs = Number(process.env.PEER_RESET_MS);
const psk = Buffer.alloc(32, 0x42);

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
      }
    });
  });
}

const server = mode === 'silent-tcp' ? createSilentTcpServer() : createPskServer();
server.listen(0, '127.0.0.1', () => {
  const {port} = server.address() as AddressInfo;
  process.stdout.write(String(port));
});
