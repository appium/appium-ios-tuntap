import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {once} from 'node:events';
import {connect} from 'node:net';
import {afterEach, describe, it} from 'node:test';
import {createServer, type TLSSocket} from 'node:tls';

import {TunnelForwarder} from '../../../src/index.js';
import type {TunnelInfo} from '../../../src/tunnel/types.js';
import {TEST_TLS_CERT, TEST_TLS_KEY} from '../../fixtures/tls.js';

/**
 * Adversarial coverage of the native CDTunnel handshake parser reached through a
 * real TLS session: TunnelForwarder.connect + handshake drive
 * TunnelSslClient::Connect, SslReadExact, and ParseHandshakeJson end to end. A
 * local TLS server plays a hostile device and returns crafted handshake frames.
 *
 * POSIX only: this exercises the fd-handoff connect path. The Windows loopback
 * bridge path (connectHost) is listed for separate on-device testing.
 */

const HANDSHAKE_MAGIC = 'CDTunnel';
const CDTUNNEL_HEADER_SIZE = 10;
const MAX_BODY = 0xffff;
const SPLIT_DELAY_MS = 60;
const CLOSE_DELAY_MS = 80;

/** Builds a CDTunnel frame; `magic`/`lenOverride` let a case lie about either header field. */
function frame(body: string | Buffer, opts: {magic?: string; lenOverride?: number} = {}): Buffer {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const header = Buffer.alloc(CDTUNNEL_HEADER_SIZE);
  header.write((opts.magic ?? HANDSHAKE_MAGIC).slice(0, 8), 0, 'latin1');
  header.writeUInt16BE(opts.lenOverride ?? payload.length & 0xffff, 8);
  return Buffer.concat([header, payload]);
}

function handshakeBody(fields: {
  address?: string;
  mtu?: unknown;
  serverAddress?: string;
  serverRSDPort?: unknown;
}): string {
  const client: Record<string, unknown> = {};
  if (fields.address !== undefined) {
    client.address = fields.address;
  }
  if (fields.mtu !== undefined) {
    client.mtu = fields.mtu;
  }
  return JSON.stringify({
    clientParameters: client,
    serverAddress: fields.serverAddress ?? 'fd00::1',
    serverRSDPort: fields.serverRSDPort ?? 1,
    type: 'serverHandshakeResponse',
  });
}

interface HandshakeAttempt {
  connected: boolean;
  info?: TunnelInfo;
  error?: string;
}

/**
 * Stands up a one-shot TLS server that runs `respond` on the device's handshake
 * request, connects the native forwarder to it, and returns the handshake outcome.
 */
async function attemptHandshake(respond: (socket: TLSSocket) => void): Promise<HandshakeAttempt> {
  const server = createServer(
    {cert: TEST_TLS_CERT, key: TEST_TLS_KEY, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2'},
    (socket) => {
      socket.on('error', () => {});
      socket.once('data', () => respond(socket));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as {port: number};

  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const forwarder = new TunnelForwarder();
  try {
    await forwarder.connect(socket, {cert: TEST_TLS_CERT, key: TEST_TLS_KEY, deviceCert: TEST_TLS_CERT});
    try {
      const info = await forwarder.handshake(1280);
      return {connected: true, info};
    } catch (err) {
      return {connected: true, error: (err as Error).message};
    }
  } catch (err) {
    return {connected: false, error: (err as Error).message};
  } finally {
    forwarder.stop();
    server.close();
  }
}

describe(
  'CDTunnel handshake parsing',
  {skip: process.platform === 'win32' && 'POSIX fd handoff only', timeout: 20000},
  () => {
    let cleanup: Array<() => void> = [];
    afterEach(() => {
      for (const fn of cleanup) {
        fn();
      }
      cleanup = [];
    });

    it('parses a well-formed handshake response', async () => {
      const body = handshakeBody({address: 'fd00::2', mtu: 1400, serverAddress: 'fd00::1', serverRSDPort: 58783});
      const result = await attemptHandshake((s) => s.write(frame(body)));
      assert.strictEqual(result.error, undefined);
      assert.deepStrictEqual(result.info, {
        clientParameters: {address: 'fd00::2', mtu: 1400},
        serverAddress: 'fd00::1',
        serverRSDPort: 58783,
      });
    });

    it('reassembles a response split between header and body across TLS records', async () => {
      const body = handshakeBody({address: 'fd00::2', mtu: 1400, serverAddress: 'fd00::1', serverRSDPort: 58783});
      const full = frame(body);
      const result = await attemptHandshake((s) => {
        s.write(full.subarray(0, CDTUNNEL_HEADER_SIZE));
        const timer = setTimeout(() => s.write(full.subarray(CDTUNNEL_HEADER_SIZE)), SPLIT_DELAY_MS);
        cleanup.push(() => clearTimeout(timer));
      });
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.info?.clientParameters.mtu, 1400);
    });

    it('rejects a bad magic without reading the body length', async () => {
      const result = await attemptHandshake((s) =>
        s.write(frame(handshakeBody({address: 'fd00::2', mtu: 1280}), {magic: 'XXTunnel'})),
      );
      assert.match(result.error ?? '', /Invalid CDTunnel magic/);
    });

    it('rejects a header truncated below 10 bytes then closed', async () => {
      const result = await attemptHandshake((s) => {
        s.write(Buffer.from('CDTun'));
        const timer = setTimeout(() => s.destroy(), CLOSE_DELAY_MS);
        cleanup.push(() => clearTimeout(timer));
      });
      assert.match(result.error ?? '', /Failed to read CDTunnel handshake header/);
    });

    it('rejects when the length field exceeds the body delivered', async () => {
      const result = await attemptHandshake((s) => {
        s.write(frame('', {lenOverride: 500}));
        const timer = setTimeout(() => s.destroy(), CLOSE_DELAY_MS);
        cleanup.push(() => clearTimeout(timer));
      });
      assert.match(result.error ?? '', /Failed to read CDTunnel handshake body/);
    });

    it('rejects a zero-length body', async () => {
      const result = await attemptHandshake((s) => s.write(frame('')));
      assert.match(result.error ?? '', /missing clientParameters/);
    });

    it('rejects a maximum-length body of non-JSON garbage', async () => {
      const result = await attemptHandshake((s) => s.write(frame(Buffer.alloc(MAX_BODY, 0x41))));
      assert.match(result.error ?? '', /missing clientParameters/);
    });

    it('rejects a response missing the mtu field', async () => {
      const result = await attemptHandshake((s) => s.write(frame(handshakeBody({address: 'fd00::2'}))));
      assert.match(result.error ?? '', /Failed to parse handshake response fields/);
    });

    it('truncates an mtu past 2^32 to its low 32 bits', async () => {
      const result = await attemptHandshake((s) =>
        s.write(frame(handshakeBody({address: 'fd00::2', mtu: 4294968576}))),
      );
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.info?.clientParameters.mtu, 1280);
    });

    it('truncates a serverRSDPort past 2^16 to its low 16 bits', async () => {
      const result = await attemptHandshake((s) =>
        s.write(frame(handshakeBody({address: 'fd00::2', mtu: 1280, serverRSDPort: 124319}))),
      );
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.info?.serverRSDPort, 58783);
    });
  },
);
