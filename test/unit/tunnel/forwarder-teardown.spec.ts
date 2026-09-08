import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {connect, type Socket} from 'node:net';
import {describe, it} from 'node:test';

import {TunTap, TunnelForwarder} from '../../../src/index.js';
import {hasPrivileges} from '../../utils.js';

/**
 * Teardown ordering: stop() while a connect or handshake is in flight, and
 * TunTap.close() while the forwarding loops run. Peers live in a child process
 * because a stop() that waits for its worker blocks this event loop.
 */

const PSK = Buffer.alloc(32, 0x42);
const PSK_IDENTITY = 'Client_identity';
const STOP_AFTER_MS = 300;
const PEER_RESET_MS = 1500;
const MIN_STOP_WAIT_MS = 500;
const DEVICE_CLOSE_REPORT_MS = 5000;
const POSIX_ONLY = process.platform === 'win32' && 'POSIX fd handoff only';

const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root privileges';

type PeerMode = 'silent-tcp' | 'handshake-stall' | 'handshake-ok';

const PEER_SCRIPT = `
  const net = require('node:net');
  const tls = require('node:tls');
  const mode = process.env.PEER_MODE;
  const resetMs = Number(process.env.PEER_RESET_MS);
  const psk = Buffer.alloc(32, 0x42);
  const frame = (bodyLength, body) => {
    const header = Buffer.alloc(10);
    header.write('CDTunnel', 0, 'ascii');
    header.writeUInt16BE(bodyLength, 8);
    return Buffer.concat([header, body]);
  };
  const handshakeBody = Buffer.from(JSON.stringify({
    clientParameters: {address: 'fd00::2', mtu: 1280}, serverAddress: 'fd00::1', serverRSDPort: 1234,
  }));
  let server;
  if (mode === 'silent-tcp') {
    server = net.createServer((socket) => {
      socket.on('error', () => {});
      setTimeout(() => socket.destroy(), resetMs);
    });
  } else {
    const options = {
      pskCallback: (_socket, identity) => (identity === 'Client_identity' ? psk : null),
      ciphers: 'PSK-AES256-CBC-SHA:@SECLEVEL=0', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    };
    server = tls.createServer(options, (socket) => {
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
  server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
`;

/** Starts a peer in a child process; resolves with its port. */
async function startPeer(mode: PeerMode) {
  const env = {...process.env, PEER_MODE: mode, PEER_RESET_MS: String(PEER_RESET_MS)};
  const peer = spawn(process.execPath, ['-e', PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit'], env});
  const [chunk] = await once(peer.stdout, 'data');
  return {peer, port: Number(String(chunk))};
}

async function connectedSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  return socket;
}

/** Calls stop() and returns how long it blocked, in milliseconds. */
function timedStop(forwarder: TunnelForwarder): number {
  const startedAt = Date.now();
  forwarder.stop();
  return Date.now() - startedAt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TunnelForwarder teardown', {skip: POSIX_ONLY, timeout: 20000}, () => {
  it('stop() waits for an in-flight connect instead of freeing the session under it', async () => {
    const {peer, port} = await startPeer('silent-tcp');
    const socket = await connectedSocket(port);
    const forwarder = new TunnelForwarder();
    try {
      const pending = forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
      pending.catch(() => {});
      await delay(STOP_AFTER_MS);
      const stopMs = timedStop(forwarder);
      await assert.rejects(pending, /SSL_connect/);
      assert.ok(stopMs >= MIN_STOP_WAIT_MS, `stop() returned after ${stopMs}ms while the connect was still in flight`);
    } finally {
      forwarder.stop();
      socket.destroy();
      peer.kill();
    }
  });

  it('stop() waits for an in-flight handshake instead of freeing the session under it', async () => {
    const {peer, port} = await startPeer('handshake-stall');
    const socket = await connectedSocket(port);
    const forwarder = new TunnelForwarder();
    try {
      await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
      const pending = forwarder.handshake(1280);
      pending.catch(() => {});
      await delay(STOP_AFTER_MS);
      const stopMs = timedStop(forwarder);
      await assert.rejects(pending, /handshake/);
      assert.ok(
        stopMs >= MIN_STOP_WAIT_MS,
        `stop() returned after ${stopMs}ms while the handshake was still in flight`,
      );
    } finally {
      forwarder.stop();
      socket.destroy();
      peer.kill();
    }
  });

  it('reports the device closing under running loops and stops cleanly', {skip: skipWithoutPrivileges}, async () => {
    const {peer, port} = await startPeer('handshake-ok');
    const socket = await connectedSocket(port);
    const forwarder = new TunnelForwarder();
    const tun = new TunTap();
    try {
      await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
      await forwarder.handshake(1280);
      assert.ok(tun.open());
      const reported = new Promise<string>((resolve) => forwarder.startForwarding(tun, resolve));
      await delay(STOP_AFTER_MS);
      tun.close();
      const timeout = delay(DEVICE_CLOSE_REPORT_MS).then(() => {
        throw new Error('forwarder never reported the closed device');
      });
      const message = await Promise.race([reported, timeout]);
      assert.match(message, /TUN/);
      assert.doesNotThrow(() => forwarder.stop());
    } finally {
      forwarder.stop();
      if (tun.isOpen && !tun.isClosed) {
        tun.close();
      }
      socket.destroy();
      peer.kill();
    }
  });
});
