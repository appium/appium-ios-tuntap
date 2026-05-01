import assert from 'node:assert';
import {TunTap} from '../../lib/index.js';
import {hasPrivileges} from '../utils.mjs';

/**
 * NOTE: Most TunTap tests require elevated privileges (root on POSIX,
 * Administrator on Windows). They fail fast otherwise.
 */

describe('TunTap Unit Tests', function () {
  let tun;

  before(function () {
    if (!hasPrivileges()) {
      throw new Error(
        process.platform === 'win32'
          ? 'Must be run from an elevated PowerShell (Run as administrator)'
          : 'Must be run as root',
      );
    }
  });

  afterEach(function () {
    if (tun && tun.isOpen && !tun.isClosed) {
      try {
        tun.close();
      } catch {}
    }
    tun = null;
  });

  it('should open and close the TUN device', function () {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    assert.strictEqual(typeof tun.name, 'string');
    // Windows uses WinTun handles; there is no numeric fd, getFd() returns -1.
    if (process.platform !== 'win32') {
      assert.ok(tun.fd > 0);
    }
    assert.strictEqual(tun.close(), true, 'TUN device should close');
  });

  it('should throw if reading/writing when closed', function () {
    tun = new TunTap();
    assert.throws(() => tun.read(4096), /Device not open/);
    assert.throws(() => tun.write(Buffer.alloc(10)), /Device not open/);
  });

  it('should throw if reopening after close', function () {
    tun = new TunTap();
    tun.open();
    tun.close();
    assert.throws(() => tun.open(), /Device has been closed/);
  });

  it('should handle configure and add/remove route', async function () {
    tun = new TunTap();
    tun.open();
    await tun.configure('fd00::2', 1500);
    await tun.addRoute('fd00::/64');
    await tun.removeRoute('fd00::/64');
    tun.close();
  });

  it('should not leave open handles after close', function (done) {
    tun = new TunTap();
    tun.open();
    tun.close();
    setTimeout(() => {
      const handles = process._getActiveHandles().filter(
        (h) =>
          // Filter out the process's own stdio handles
          !(
            h.constructor &&
            h.constructor.name &&
            h.constructor.name.match(/(Socket|WriteStream|ReadStream)/)
          ),
      );
      assert.ok(handles.length <= 2, 'No extra handles should remain after close');
      done();
    }, 100);
  });

  it('should handle errors gracefully', async function () {
    tun = new TunTap();
    tun.open();
    await assert.rejects(() => tun.configure('invalid', 1500), /Invalid IPv6 address/);
    await assert.rejects(() => tun.configure('fd00::3', 100), /MTU must be between/);
    tun.close();
  });
});
