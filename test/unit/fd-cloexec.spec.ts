import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {readdirSync, readlinkSync} from 'node:fs';
import {connect, type Socket} from 'node:net';
import {afterEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {TunTap, TunnelForwarder} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

/**
 * Children spawned while a tunnel is up must not inherit the TUN fd or the
 * duplicated TLS socket. Only observable on Linux: macOS spawns children with
 * close-on-exec forced on every fd, so a leak there is invisible from JS.
 */

const LINUX_ONLY = process.platform !== 'linux' && 'Linux /proc/self/fd only';
const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root privileges';
const PSK = Buffer.alloc(32, 0x42);
const PSK_IDENTITY = 'Client_identity';
const PEER_RESET_MS = 5000;
const PEER_SCRIPT = fileURLToPath(new URL('../fixtures/tunnel-peer.js', import.meta.url));
const TUN_DEVICE_PATH = '/dev/net/tun';
const SOCKET_TARGET = /^socket:\[\d+\]$/;
const execFileAsync = promisify(execFile);

/** Link targets of every fd this process holds open; skips the listing's own dir fd. */
function ownFdTargets(): string[] {
  return readdirSync('/proc/self/fd').flatMap((fd) => {
    try {
      return [readlinkSync(`/proc/self/fd/${fd}`)];
    } catch {
      return [];
    }
  });
}

/** Link targets of every fd a freshly spawned child holds open. */
async function childFdTargets(): Promise<string[]> {
  const {stdout} = await execFileAsync('sh', ['-c', 'ls -l /proc/self/fd']);
  return stdout
    .split('\n')
    .map((line) => line.split(' -> ')[1])
    .filter((target): target is string => target !== undefined);
}

/** Starts a TLS-PSK peer whose CDTunnel handshake stalls; resolves with its port. */
async function startStallingPeer(): Promise<{peer: ChildProcess; port: number}> {
  const env = {...process.env, PEER_MODE: 'handshake-stall', PEER_RESET_MS: String(PEER_RESET_MS)};
  const peer = spawn(process.execPath, [PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit'], env});
  const [chunk] = await once(peer.stdout, 'data');
  return {peer, port: Number(String(chunk))};
}

describe('fd close-on-exec', {skip: LINUX_ONLY, timeout: 20000}, () => {
  let tun: TunTap | undefined;
  let forwarder: TunnelForwarder | undefined;
  let socket: Socket | undefined;
  let peer: ChildProcess | undefined;

  afterEach(() => {
    forwarder?.stop();
    if (tun?.isOpen && !tun.isClosed) {
      tun.close();
    }
    socket?.destroy();
    peer?.kill();
    tun = forwarder = socket = peer = undefined;
  });

  it(
    'a child spawned while the device is open does not inherit the TUN fd',
    {skip: skipWithoutPrivileges},
    async () => {
      tun = new TunTap();
      assert.ok(tun.open());
      assert.ok(ownFdTargets().includes(TUN_DEVICE_PATH), 'parent should hold the TUN device');

      const inherited = await childFdTargets();
      assert.ok(!inherited.includes(TUN_DEVICE_PATH), `child inherited the TUN fd: ${inherited.join(', ')}`);
    },
  );

  it('a child spawned while the TLS session is up does not inherit the duplicated socket', async () => {
    const started = await startStallingPeer();
    peer = started.peer;
    socket = connect(started.port, '127.0.0.1');
    await once(socket, 'connect');
    forwarder = new TunnelForwarder();
    await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
    const ownSockets = ownFdTargets().filter((target) => SOCKET_TARGET.test(target));

    const inherited = (await childFdTargets()).filter((target) => ownSockets.includes(target));
    assert.deepStrictEqual(inherited, [], 'child inherited the duplicated TLS socket');
  });
});
