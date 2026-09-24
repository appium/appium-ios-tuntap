import assert from 'node:assert';
import {execFile} from 'node:child_process';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {TunTap} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

const execFileAsync = promisify(execFile);

const INSTANCE_COUNT = process.getMaxListeners() + 1;
const OPEN_DEVICE_COUNT = 3;
const INDEX_URL = new URL('../../src/index.js', import.meta.url).href;
const EXIT_CLEANUP_SCRIPT = `
  import {TunTap} from '${INDEX_URL}';
  const devices = Array.from({length: ${OPEN_DEVICE_COUNT}}, (_, i) => new TunTap('appium-exit-' + i));
  devices.forEach((device) => device.open());
  const listeners = process.listenerCount('exit');
  process.once('exit', () => {
    process.stdout.write(JSON.stringify({listeners, closed: devices.map((device) => device.isClosed)}));
  });
`;

const skipWithoutPrivileges = (await hasPrivileges()) ? false : 'Requires root or Administrator privileges';

describe('TunTap exit cleanup', {timeout: 15000}, () => {
  it('does not add an exit listener per instance', () => {
    const before = process.listenerCount('exit');
    const devices = Array.from({length: INSTANCE_COUNT}, () => new TunTap());
    try {
      assert.strictEqual(process.listenerCount('exit'), before);
    } finally {
      devices.forEach((device) => device.close());
    }
  });

  it('closes every device still open at process exit through one listener', {skip: skipWithoutPrivileges}, async () => {
    const {stdout} = await execFileAsync(process.execPath, ['--input-type=module', '-e', EXIT_CLEANUP_SCRIPT]);
    assert.deepStrictEqual(JSON.parse(stdout), {
      listeners: 1,
      closed: Array.from({length: OPEN_DEVICE_COUNT}, () => true),
    });
  });
});
