import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {connect} from 'node:net';
import {describe, it} from 'node:test';

import {TunnelForwarder} from '../../../src/index.js';

const PEER_RESET_DELAY_MS = 2000;
const TICK_INTERVAL_MS = 50;

/** Runs in a child process: an in-process timer could never fire while the loop under test is frozen. */
const SILENT_PEER_SCRIPT = `
  const net = require('node:net');
  const server = net.createServer((socket) => setTimeout(() => socket.destroy(), ${PEER_RESET_DELAY_MS}));
  server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
`;

/** Starts a TCP peer that accepts, stays silent, then resets the connection; resolves with its port. */
async function startSilentPeer() {
  const peer = spawn(process.execPath, ['-e', SILENT_PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit']});
  const [chunk] = await once(peer.stdout, 'data');
  return {peer, port: Number(String(chunk))};
}

describe('TunnelForwarder.connectPsk', {skip: process.platform === 'win32' && 'POSIX fd handoff only'}, () => {
  it('keeps the event loop running while the TLS connect waits on the peer', async () => {
    const {peer, port} = await startSilentPeer();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const forwarder = new TunnelForwarder();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, TICK_INTERVAL_MS);
    const startedAt = Date.now();
    try {
      await assert.rejects(forwarder.connectPsk(socket, {psk: Buffer.alloc(32, 1)}), /SSL_connect/);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs >= PEER_RESET_DELAY_MS / 2,
        `connect returned after ${elapsedMs}ms without waiting on the peer`,
      );
      assert.ok(
        ticks > 0,
        `event loop was blocked for the whole ${elapsedMs}ms TLS connect (0 ticks of a ${TICK_INTERVAL_MS}ms interval)`,
      );
    } finally {
      clearInterval(ticker);
      forwarder.stop();
      socket.destroy();
      peer.kill();
    }
  });
});
