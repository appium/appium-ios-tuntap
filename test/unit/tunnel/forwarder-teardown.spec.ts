import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {connect, type Socket} from 'node:net';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

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
const PEER_SCRIPT = fileURLToPath(new URL('../../fixtures/tunnel-peer.js', import.meta.url));

const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root privileges';

type PeerMode = 'silent-tcp' | 'handshake-stall' | 'handshake-ok';

/** Starts a peer in a child process; resolves with its port. */
async function startPeer(mode: PeerMode) {
  const env = {...process.env, PEER_MODE: mode, PEER_RESET_MS: String(PEER_RESET_MS)};
  const peer = spawn(process.execPath, [PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit'], env});
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
  let peer: ChildProcess;
  let socket: Socket;
  let forwarder: TunnelForwarder;
  let tun: TunTap | undefined;

  /** Starts a peer of the given mode and connects a socket to it. */
  async function connectPeer(mode: PeerMode): Promise<void> {
    const started = await startPeer(mode);
    peer = started.peer;
    socket = await connectedSocket(started.port);
  }

  beforeEach(() => {
    forwarder = new TunnelForwarder();
    tun = undefined;
  });

  afterEach(() => {
    forwarder.stop();
    if (tun?.isOpen && !tun.isClosed) {
      tun.close();
    }
    socket.destroy();
    peer.kill();
  });

  it('stop() waits for an in-flight connect instead of freeing the session under it', async () => {
    await connectPeer('silent-tcp');
    const pending = forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
    pending.catch(() => {});
    await delay(STOP_AFTER_MS);
    const stopMs = timedStop(forwarder);
    await assert.rejects(pending, /SSL_connect/);
    assert.ok(stopMs >= MIN_STOP_WAIT_MS, `stop() returned after ${stopMs}ms while the connect was still in flight`);
  });

  it('stop() waits for an in-flight handshake instead of freeing the session under it', async () => {
    await connectPeer('handshake-stall');
    await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
    const pending = forwarder.handshake(1280);
    pending.catch(() => {});
    await delay(STOP_AFTER_MS);
    const stopMs = timedStop(forwarder);
    await assert.rejects(pending, /handshake/);
    assert.ok(stopMs >= MIN_STOP_WAIT_MS, `stop() returned after ${stopMs}ms while the handshake was still in flight`);
  });

  it('reports the device closing under running loops and stops cleanly', {skip: skipWithoutPrivileges}, async () => {
    await connectPeer('handshake-ok');
    const device = new TunTap();
    tun = device;
    await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
    await forwarder.handshake(1280);
    assert.ok(device.open());
    const reported = new Promise<string>((resolve) => forwarder.startForwarding(device, resolve));
    await delay(STOP_AFTER_MS);
    device.close();
    const timeout = delay(DEVICE_CLOSE_REPORT_MS).then(() => {
      throw new Error('forwarder never reported the closed device');
    });
    const message = await Promise.race([reported, timeout]);
    assert.match(message, /TUN/);
    assert.doesNotThrow(() => forwarder.stop());
  });
});
