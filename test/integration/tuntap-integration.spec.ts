import assert from 'node:assert';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {TunTap} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hasRequiredPrivileges = await hasPrivileges();
const skipWithoutPrivileges = getPrivilegeSkipReason(hasRequiredPrivileges);

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
    await assert.rejects(() => activeTun.configure('fd00::1', 50), /MTU must be between/);
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

function getPrivilegeSkipReason(hasRequiredPrivileges: boolean): boolean | string {
  if (hasRequiredPrivileges) {
    return false;
  }
  return process.platform === 'win32' ? 'Requires Administrator privileges on Windows' : 'Requires root privileges';
}
