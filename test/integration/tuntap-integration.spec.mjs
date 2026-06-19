import assert from 'node:assert';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {TunTap} from '../../lib/index.js';
import {hasPrivileges} from '../utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hasRequiredPrivileges = await hasPrivileges();
const skipWithoutPrivileges = getPrivilegeSkipReason(hasRequiredPrivileges);

describe('TunTap Integration Tests', {timeout: 15000}, () => {
  let tun;

  describe('TunTap CLI Utility Signal Handling', {skip: process.platform === 'win32'}, () => {
    // Windows does not deliver POSIX signals to child processes the way Unix
    // does. `child.kill('SIGINT')` is a forced termination, so the cooperative
    // cleanup path this test exercises does not apply.
    it('should exit promptly and clean up on SIGINT', {timeout: 10_000}, async () => {
      const cliPath = path.resolve(__dirname, '../test-tuntap.mjs');
      const child = spawn('node', [cliPath], {stdio: ['ignore', 'pipe', 'pipe']});

      setTimeout(() => {
        child.kill('SIGINT');
      }, 500);

      await new Promise((resolve, reject) => {
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

  it(
    'should read and write data (simulate traffic)',
    {timeout: 10000, skip: skipWithoutPrivileges},
    async () => {
      tun = new TunTap();
      assert.strictEqual(tun.open(), true, 'TUN device should open');
      await tun.configure('fd00::1', 1500);
      await new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let readCount = 0;
        const timeout = setTimeout(() => {
          tun.close();
          resolve();
        }, 3000);

        const interval = setInterval(() => {
          try {
            const data = tun.read(4096);
            if (data && data.length > 0) {
              readCount++;
              const bytesWritten = tun.write(data);
              assert.strictEqual(
                bytesWritten,
                data.length,
                'Should echo back same number of bytes',
              );
              clearTimeout(timeout);
              clearInterval(interval);
              tun.close();
              resolve();
            }
          } catch (err) {
            clearTimeout(timeout);
            clearInterval(interval);
            tun.close();
            reject(err);
          }
        }, 100);
      });
    },
  );

  it('should fail to open an already closed device', {skip: skipWithoutPrivileges}, () => {
    tun = new TunTap();
    tun.open();
    tun.close();
    assert.throws(() => tun.open(), /Device has been closed/);
  });

  it('should throw on invalid configuration', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    tun.open();
    await assert.rejects(() => tun.configure('not-an-ip', 1500), /Invalid IPv6 address/);
    await assert.rejects(() => tun.configure('fd00::1', 50), /MTU must be between/);
    tun.close();
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

function getPrivilegeSkipReason(hasRequiredPrivileges) {
  if (hasRequiredPrivileges) {
    return false;
  }
  return process.platform === 'win32'
    ? 'Requires Administrator privileges on Windows'
    : 'Requires root privileges';
}
