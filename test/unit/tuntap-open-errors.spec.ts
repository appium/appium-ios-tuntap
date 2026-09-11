import assert from 'node:assert';
import {describe, it} from 'node:test';

import {TunTap, TunTapPermissionError} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

const hasRequiredPrivileges = await hasPrivileges();
const skipReason = getSkipReason(hasRequiredPrivileges);

describe('TunTap open() error mapping', {timeout: 10000}, () => {
  it('should throw TunTapPermissionError when opened without root', {skip: skipReason}, () => {
    const tun = new TunTap();
    assert.throws(
      () => tun.open(),
      (err: unknown) => {
        assert.ok(err instanceof TunTapPermissionError);
        assert.ok(err.cause instanceof Error);
        assert.strictEqual(err.cause.message, err.message);
        return true;
      },
    );
  });
});

function getSkipReason(privileged: boolean): string | false {
  if (process.platform === 'win32') {
    return 'Only covers darwin/linux';
  }
  return privileged ? 'Requires a non-root process' : false;
}
