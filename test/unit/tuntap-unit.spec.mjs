import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import {TunTap, TunnelForwarder} from '../../lib/index.js';
import {hasPrivileges} from '../utils.mjs';

/**
 * NOTE: Most TunTap tests require elevated privileges (root on POSIX,
 * Administrator on Windows), so privileged cases are skipped when needed.
 */

const hasRequiredPrivileges = await hasPrivileges();
const skipWithoutPrivileges = getPrivilegeSkipReason(hasRequiredPrivileges);

describe('TunTap Unit Tests', {timeout: 10000}, () => {
  let tun;

  afterEach(() => {
    if (tun && tun.isOpen && !tun.isClosed) {
      try {
        tun.close();
      } catch {}
    }
    tun = null;
  });

  it('should expose the native tunnel forwarder', () => {
    const forwarder = new TunnelForwarder();
    assert.strictEqual(typeof forwarder.connect, 'function');
    assert.strictEqual(typeof forwarder.connectPsk, 'function');
    assert.strictEqual(typeof forwarder.handshake, 'function');
    assert.strictEqual(typeof forwarder.startForwarding, 'function');
    forwarder.stop();
  });

  it('should open and close the TUN device', {skip: skipWithoutPrivileges}, () => {
    tun = new TunTap();
    assert.strictEqual(tun.open(), true, 'TUN device should open');
    assert.strictEqual(typeof tun.name, 'string');
    // Windows uses WinTun handles; there is no numeric fd, getFd() returns -1.
    if (process.platform !== 'win32') {
      assert.ok(tun.fd > 0);
    }
    assert.strictEqual(tun.close(), true, 'TUN device should close');
  });

  it('should throw if reading/writing when closed', () => {
    tun = new TunTap();
    assert.throws(() => tun.read(4096), /Device not open/);
    assert.throws(() => tun.write(Buffer.alloc(10)), /Device not open/);
  });

  it('should throw if reopening after close', {skip: skipWithoutPrivileges}, () => {
    tun = new TunTap();
    tun.open();
    tun.close();
    assert.throws(() => tun.open(), /Device has been closed/);
  });

  it('should handle configure and add/remove route', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    tun.open();
    await tun.configure('fd00::2', 1500);
    await tun.addRoute('fd01::/64');
    await tun.removeRoute('fd01::/64');
    tun.close();
  });

  it('should not leave open handles after close', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    tun.open();
    tun.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  });

  it('should handle errors gracefully', {skip: skipWithoutPrivileges}, async () => {
    tun = new TunTap();
    tun.open();
    await assert.rejects(() => tun.configure('invalid', 1500), /Invalid IPv6 address/);
    await assert.rejects(() => tun.configure('fd00::3', 100), /MTU must be between/);
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
