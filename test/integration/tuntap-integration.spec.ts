import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {createSocket, type Socket} from 'node:dgram';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {TunTap} from '../../src/index.js';
import {IPV6_HEADER_SIZE, IPV6_VERSION} from '../../src/tunnel/constants.js';
import {hasPrivileges} from '../utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hasRequiredPrivileges = await hasPrivileges();
const skipWithoutPrivileges = getPrivilegeSkipReason(hasRequiredPrivileges);
const skipUnlessPrivilegedWindows =
  process.platform === 'win32' ? skipWithoutPrivileges : 'WinTun read path is Windows-only';

const PROBE_ROUTE = 'fd01::/64';
const PROBE_DESTINATION = 'fd01::2';
const PROBE_DESTINATION_BYTES = Buffer.from('fd010000000000000000000000000002', 'hex');
const PROBE_PORT = 9;
const PROBE_PAYLOAD = Buffer.alloc(512, 0xab);
const UDP_HEADER_SIZE = 8;
const PROBE_PACKET_SIZE = IPV6_HEADER_SIZE + UDP_HEADER_SIZE + PROBE_PAYLOAD.length;
const TRUNCATING_READ_SIZE = 64;

describe('TunTap Integration Tests', {timeout: 15000}, () => {
  let tun: TunTap | null;

  describe('TunTap CLI Utility Signal Handling', {skip: process.platform === 'win32'}, () => {
    // Windows does not deliver POSIX signals to child processes the way Unix
    // does. `child.kill('SIGINT')` is a forced termination, so the cooperative
    // cleanup path this test exercises does not apply.
    it('should exit promptly and clean up on SIGINT', {timeout: 10_000}, async () => {
      const cliPath = path.resolve(__dirname, '../test-tuntap.js');
      const child = spawn('node', [cliPath], {stdio: ['ignore', 'pipe', 'pipe']});

      setTimeout(() => {
        child.kill('SIGINT');
      }, 500);

      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code, signal) => {
          if (signal === 'SIGINT' || code === 0) {
            resolve();
          } else {
            reject(new Error(`Process exited with code ${code} and signal ${signal}`));
          }
        });

        child.on('error', reject);
      });
    });
  });

  afterEach(() => {
    if (tun && tun.isOpen && !tun.isClosed) {
      try {
        tun.close();
      } catch {}
    }
    tun = null;
  });

  it('should open, configure, add route, and close', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    assert.strictEqual(typeof tun.name, 'string');
    // Windows uses WinTun handles; there is no numeric fd, getFd() returns -1.
    if (process.platform !== 'win32') {
      assert.ok(tun.fd > 0);
    }

    await tun.configure('fd00::1', 1500);
    await tun.addRoute('fd01::/64');

    await tun.removeRoute('fd01::/64');
    assert.strictEqual(tun.close(), true, 'TUN device should close');
  });

  it('should read and write data (simulate traffic)', {timeout: 10000, skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    await tun.configure('fd00::1', 1500);
    const activeTun = tun;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        activeTun.close();
        resolve();
      }, 3000);

      const interval = setInterval(() => {
        try {
          const data = activeTun.read(4096);
          if (data && data.length > 0) {
            const bytesWritten = activeTun.write(data);
            assert.strictEqual(bytesWritten, data.length, 'Should echo back same number of bytes');
            clearTimeout(timeout);
            clearInterval(interval);
            activeTun.close();
            resolve();
          }
        } catch (err) {
          clearTimeout(timeout);
          clearInterval(interval);
          activeTun.close();
          reject(err);
        }
      }, 100);
    });
  });

  it(
    'should not return a packet shorter than its IPv6 header claims',
    {timeout: 15000, skip: skipUnlessPrivilegedWindows},
    async () => {
      tun = new TunTap();
      assert.strictEqual(tun.open(), true, 'TUN device should open');
      await tun.configure('fd00::1', 1500);
      await tun.addRoute(PROBE_ROUTE);
      const socket = createSocket('udp6');
      try {
        const fullPacket = await readProbePacket(tun, socket, 4096, 5000);
        assert.strictEqual(fullPacket?.length, PROBE_PACKET_SIZE, 'probe datagram should reach the TUN device intact');

        const cappedPacket = await readProbePacket(tun, socket, TRUNCATING_READ_SIZE, 2000);
        assert.ok(
          cappedPacket === null || cappedPacket.length >= claimedIpv6Length(cappedPacket),
          `read(${TRUNCATING_READ_SIZE}) returned ${cappedPacket?.length} bytes of a ${PROBE_PACKET_SIZE}-byte packet`,
        );
      } finally {
        socket.close();
      }
    },
  );

  it('should fail to open an already closed device', {skip: skipWithoutPrivileges}, () => {
    tun = new TunTap();
    const activeTun = tun;
    activeTun.open();
    activeTun.close();
    assert.throws(() => activeTun.open(), /Device has been closed/);
  });

  it('should throw on invalid configuration', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    const activeTun = tun;
    activeTun.open();
    await assert.rejects(() => activeTun.configure('not-an-ip', 1500), /Invalid IPv6 address/);
    await assert.rejects(() => activeTun.configure('fd00::1', 50), /MTU must be an integer between/);
    activeTun.close();
  });

  it('should get interface statistics', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    tun.open();
    await tun.configure('fd00::1', 1500);
    const stats = await tun.getStats();
    assert.ok(typeof stats.rxBytes === 'number');
    assert.ok(typeof stats.txBytes === 'number');
    tun.close();
  });
});

/** Sends UDP probes until one is read back from the TUN device; null once `windowMs` elapses. */
async function readProbePacket(tun: TunTap, socket: Socket, maxSize: number, windowMs: number): Promise<Buffer | null> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await sendProbe(socket);
    await delay(100);
    for (let packet = tun.read(maxSize); packet.length > 0; packet = tun.read(maxSize)) {
      if (isProbePacket(packet)) {
        return packet;
      }
    }
  }
  return null;
}

function sendProbe(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(PROBE_PAYLOAD, PROBE_PORT, PROBE_DESTINATION, (err) => (err ? reject(err) : resolve()));
  });
}

function isProbePacket(packet: Buffer): boolean {
  return (
    packet.length >= IPV6_HEADER_SIZE &&
    packet[0] >> 4 === IPV6_VERSION &&
    packet.subarray(24, IPV6_HEADER_SIZE).equals(PROBE_DESTINATION_BYTES)
  );
}

/** Total packet length per the IPv6 header: fixed header plus the payload-length field. */
function claimedIpv6Length(packet: Buffer): number {
  return IPV6_HEADER_SIZE + packet.readUInt16BE(4);
}

function getPrivilegeSkipReason(hasRequiredPrivileges: boolean): boolean | string {
  if (hasRequiredPrivileges) {
    return false;
  }
  return process.platform === 'win32' ? 'Requires Administrator privileges on Windows' : 'Requires root privileges';
}
