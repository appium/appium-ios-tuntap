import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {spawn, type ChildProcess} from 'node:child_process';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {connect, type Socket} from 'node:net';
import {afterEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {TunTap, TunnelForwarder} from '../../../src/index.js';
import {hasPrivileges} from '../../utils.js';

/**
 * Frame reassembly through the real forwarder: a bogus IPv6 header claiming a
 * 65535-byte payload must not hold the valid frames behind it away from the TUN.
 * Delivery is observed on a UDP socket reachable at the tunnel client address.
 */

const PSK = Buffer.alloc(32, 0x42);
const PSK_IDENTITY = 'Client_identity';
const TUNNEL_MTU = 1280;
const EXPECTED_PAYLOADS = ['frame-0', 'frame-1', 'frame-2'];
const DELIVERY_TIMEOUT_MS = 5000;
const PEER_SCRIPT = fileURLToPath(new URL('../../fixtures/tunnel-peer.js', import.meta.url));

const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root privileges';

type PeerMode = 'frames-only' | 'garbage-then-frames';

/** Starts a frame-sending peer aimed at `udpPort`; resolves with its TCP port. */
async function startPeer(mode: PeerMode, udpPort: number) {
  const env = {...process.env, PEER_MODE: mode, PEER_UDP_PORT: String(udpPort)};
  const peer = spawn(process.execPath, [PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit'], env});
  const [chunk] = await once(peer.stdout, 'data');
  return {peer, port: Number(String(chunk))};
}

/** Resolves with the distinct payloads once `count` arrive; rejects after the delivery timeout. */
function collectPayloads(udp: dgram.Socket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const received = new Set<string>();
    const timer = setTimeout(
      () => reject(new Error(`received ${received.size} of ${count} frames: [${[...received].join(', ')}]`)),
      DELIVERY_TIMEOUT_MS,
    );
    udp.on('message', (message) => {
      received.add(message.toString());
      if (received.size >= count) {
        clearTimeout(timer);
        resolve([...received].sort());
      }
    });
  });
}

describe('TunnelForwarder frame reassembly', {skip: skipWithoutPrivileges, timeout: 20000}, () => {
  let peer: ChildProcess | undefined;
  let socket: Socket | undefined;
  let udp: dgram.Socket | undefined;
  let forwarder: TunnelForwarder | undefined;
  let tun: TunTap | undefined;

  afterEach(() => {
    forwarder?.stop();
    tun?.close();
    socket?.destroy();
    peer?.kill();
    udp?.close();
  });

  /** Brings up TUN + forwarder against a peer of `mode`; resolves with the delivered payloads and forwarder errors. */
  async function forwardFrom(mode: PeerMode): Promise<{payloads: string[]; errors: string[]}> {
    udp = dgram.createSocket('udp6');
    udp.bind(0, '::');
    await once(udp, 'listening');
    const started = await startPeer(mode, udp.address().port);
    peer = started.peer;
    socket = connect(started.port, '127.0.0.1');
    await once(socket, 'connect');
    forwarder = new TunnelForwarder();
    await forwarder.connectPsk(socket, {psk: PSK, identity: PSK_IDENTITY});
    const info = await forwarder.handshake(TUNNEL_MTU);
    tun = new TunTap();
    assert.ok(tun.open());
    await tun.configure(info.clientParameters.address, info.clientParameters.mtu);
    const errors: string[] = [];
    forwarder.startForwarding(tun, (message) => errors.push(message));
    const payloads = await collectPayloads(udp, EXPECTED_PAYLOADS.length);
    return {payloads, errors};
  }

  it('control: delivers valid frames sent on their own', async () => {
    const {payloads, errors} = await forwardFrom('frames-only');
    assert.deepStrictEqual(payloads, EXPECTED_PAYLOADS);
    assert.deepStrictEqual(errors, []);
  });

  it('delivers valid frames that follow a bogus header claiming a 65535-byte payload', async () => {
    const {payloads, errors} = await forwardFrom('garbage-then-frames');
    assert.deepStrictEqual(payloads, EXPECTED_PAYLOADS);
    assert.deepStrictEqual(errors, []);
  });
});
