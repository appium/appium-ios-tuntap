import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import {CD_TUNNEL_MTU, MAX_TUNNEL_MTU_REQUEST, getRequestedTunnelMtu} from '../../../src/tunnel/constants.js';

describe('getRequestedTunnelMtu', () => {
  afterEach(() => {
    delete process.env.APPIUM_TUNTAP_MTU_REQUEST;
  });

  it('returns the default when unset', () => {
    delete process.env.APPIUM_TUNTAP_MTU_REQUEST;
    assert.strictEqual(getRequestedTunnelMtu(), CD_TUNNEL_MTU);
  });

  it('returns a valid requested value', () => {
    process.env.APPIUM_TUNTAP_MTU_REQUEST = '16000';
    assert.strictEqual(getRequestedTunnelMtu(), 16000);
  });

  it('clamps values below the IPv6 minimum', () => {
    process.env.APPIUM_TUNTAP_MTU_REQUEST = '500';
    assert.strictEqual(getRequestedTunnelMtu(), CD_TUNNEL_MTU);
  });

  it('clamps values above the maximum', () => {
    process.env.APPIUM_TUNTAP_MTU_REQUEST = '70000';
    assert.strictEqual(getRequestedTunnelMtu(), MAX_TUNNEL_MTU_REQUEST);
  });

  it('falls back to the default on non-integer input', () => {
    for (const value of ['abc', '12.5', '1280x', ' ']) {
      process.env.APPIUM_TUNTAP_MTU_REQUEST = value;
      assert.strictEqual(getRequestedTunnelMtu(), CD_TUNNEL_MTU, `input '${value}'`);
    }
  });
});
