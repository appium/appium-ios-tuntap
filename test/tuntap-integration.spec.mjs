import assert from 'node:assert';
import { TunTap } from '../lib/index.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRoot } from './utils.mjs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('TunTap Integration Tests', function () {
  let tun;

  before(function () {
    if (!isRoot()) {
      this.skip('Must be run as root');
    }
  });

describe('TunTap CLI Utility Signal Handling', function () {
  it('should exit promptly and clean up on SIGINT', function (done) {
    this.timeout(10000);

    const cliPath = path.resolve(__dirname, 'test-tuntap.mjs');
    const child = spawn('node', [cliPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    setTimeout(() => {
      child.kill('SIGINT');
    }, 500); // Give it a moment to enter the read/write step

    child.on('exit', (code, signal) => {
      // Should exit with code 0 or null (if killed by signal)
      if (signal === 'SIGINT' || code === 0) {
        done();
      } else {
        done(new Error(`Process exited with code ${code} and signal ${signal}`));
      }
    });

    child.on('error', (err) => {
      done(err);
    });
  });
});

  afterEach(function() {
    if (tun && tun.isOpen && !tun.isClosed) {
      try { tun.close(); } catch {}
    }
    tun = null;
  });

  it('should open, configure, add route, and close', async function () {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    assert.strictEqual(typeof tun.name, 'string');
    assert.ok(tun.fd > 0);

    await tun.configure('fd00::1', 1500);
    await tun.addRoute('fd00::/64');

    // Remove route and close
    await tun.removeRoute('fd00::/64');
    assert.strictEqual(tun.close(), true, 'TUN device should close');
  });

  it('should read and write data (simulate traffic)', async function () {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    await tun.configure('fd00::1', 1500);
    await new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      let readCount = 0;
      const timeout = setTimeout(() => {
        // No data received, this is normal if no traffic is sent
        tun.close();
        return resolve();
      }, 3000);

      const interval = setInterval(() => {
        try {
          const data = tun.read(4096);
          if (data && data.length > 0) {
            readCount++;
            const bytesWritten = tun.write(data);
            assert.strictEqual(bytesWritten, data.length, 'Should echo back same number of bytes');
            clearTimeout(timeout);
            clearInterval(interval);
            tun.close();
            return resolve();
          }
        } catch (err) {
          clearTimeout(timeout);
          clearInterval(interval);
          tun.close();
          return reject(err);
        }
      }, 100);
    });
  });

  it('should fail to open an already closed device', function () {
    tun = new TunTap();
    tun.open();
    tun.close();
    assert.throws(() => tun.open(), /Device has been closed/);
  });

  it('should throw on invalid configuration', async function () {
    tun = new TunTap();
    tun.open();
    await assert.rejects(() => tun.configure('not-an-ip', 1500), /Invalid IPv6 address/);
    await assert.rejects(() => tun.configure('fd00::1', 50), /MTU must be between/);
    tun.close();
  });

  it('should get interface statistics', async function () {
    tun = new TunTap();
    tun.open();
    await tun.configure('fd00::1', 1500);
    const stats = await tun.getStats();
    assert.ok(typeof stats.rxBytes === 'number');
    assert.ok(typeof stats.txBytes === 'number');
    tun.close();
  });
});
