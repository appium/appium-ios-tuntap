import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {afterEach, describe, it} from 'node:test';

import {TunTap} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

/**
 * Issue 9 probe: floods a utun with MTU-sized writes and no consumer so the
 * kernel input queue saturates, then reports whether any write surfaced
 * ENOBUFS ("No buffer space available"). One such error tears the tunnel down.
 */

const ADDRESS = 'fd00::7';
const MTU = 1500;
const IPV6_HEADER_LEN = 40;
const NEXT_HEADER_NONE = 59;
const FLOOD_MS = 3000;
const DARWIN_ONLY = process.platform !== 'darwin' && 'utun write path is macOS only';
const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root privileges';

/** Builds an MTU-sized IPv6 packet addressed from and to `address`. */
function buildPacket(address: string): Buffer {
  const packet = Buffer.alloc(MTU);
  packet[0] = 0x60;
  packet.writeUInt16BE(MTU - IPV6_HEADER_LEN, 4);
  packet[6] = NEXT_HEADER_NONE;
  packet[7] = 64;
  const raw = Buffer.alloc(16);
  raw.writeUInt16BE(0xfd00, 0);
  raw.writeUInt16BE(Number(address.split('::')[1]), 14);
  raw.copy(packet, 8);
  raw.copy(packet, 24);
  return packet;
}

describe('utun write saturation', {skip: DARWIN_ONLY || skipWithoutPrivileges, timeout: 15000}, () => {
  let tun: TunTap | undefined;

  afterEach(() => {
    tun?.close();
    tun = undefined;
  });

  it('never surfaces a buffer-space error while the input queue is saturated', async (t) => {
    tun = new TunTap();
    tun.open();
    await tun.configure(ADDRESS, MTU);

    const packet = buildPacket(ADDRESS);
    const errors = new Map<string, number>();
    let written = 0;
    let zeroLength = 0;
    const deadline = Date.now() + FLOOD_MS;
    while (Date.now() < deadline) {
      try {
        if (tun.write(packet) === 0) {
          zeroLength++;
        } else {
          written++;
        }
      } catch (err: unknown) {
        const message = (err as Error).message;
        errors.set(message, (errors.get(message) ?? 0) + 1);
      }
    }

    t.diagnostic(`written=${written} zeroLength=${zeroLength} errors=${JSON.stringify([...errors])}`);
    assert.ok(written > 0, 'flood wrote nothing');
    const bufferSpace = [...errors.keys()].filter((message) => message.includes('No buffer space available'));
    assert.deepStrictEqual(bufferSpace, [], `ENOBUFS surfaced on utun write: ${JSON.stringify([...errors])}`);
  });
});
