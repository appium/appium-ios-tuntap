import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import {CD_TUNNEL_MTU_SIZE, MAX_TUNNEL_MTU_REQUEST_SIZE, getRequestedTunnelMtu} from '../../../src/tunnel/constants.js';

describe('getRequestedTunnelMtu', () => {
  afterEach(() => {
    delete process.env.APPIUM_TUNTAP_MTU_REQUEST_SIZE;
  });

  const cases: {name: string; value: string | undefined; expected: number}[] = [
    {name: 'unset returns the default', value: undefined, expected: CD_TUNNEL_MTU_SIZE},
    {name: 'valid value is used', value: '16000', expected: 16000},
    {name: 'below IPv6 minimum clamps up', value: '500', expected: CD_TUNNEL_MTU_SIZE},
    {name: 'above maximum clamps down', value: '70000', expected: MAX_TUNNEL_MTU_REQUEST_SIZE},
    {name: 'non-numeric falls back', value: 'abc', expected: CD_TUNNEL_MTU_SIZE},
    {name: 'non-integer falls back', value: '12.5', expected: CD_TUNNEL_MTU_SIZE},
    {name: 'trailing garbage falls back', value: '1280x', expected: CD_TUNNEL_MTU_SIZE},
    {name: 'blank falls back', value: ' ', expected: CD_TUNNEL_MTU_SIZE},
  ];

  for (const {name, value, expected} of cases) {
    it(name, () => {
      if (value === undefined) {
        delete process.env.APPIUM_TUNTAP_MTU_REQUEST_SIZE;
      } else {
        process.env.APPIUM_TUNTAP_MTU_REQUEST_SIZE = value;
      }
      assert.strictEqual(getRequestedTunnelMtu(), expected);
    });
  }
});
