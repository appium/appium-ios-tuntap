import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {describe, it} from 'node:test';

import {DarwinTunTapPlatform} from '../../../src/platform/darwin.js';
import type {TunTapInterfaceStats} from '../../../src/platform/types.js';

/** utun row layout captured from macOS `netstat -I utun0 -b`: no Address column, distinct value per counter. */
const UTUN_NETSTAT_OUTPUT = [
  'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
  'utun0      1380  <Link#21>                            7     1        910       41     2       6414     0',
  'utun0      1380  lt-mbp-259. fe80:15::40e7:940        7     -        910       41     -       6414     -',
  '',
].join('\n');

/** Reference parser: resolves each counter by header name, anchored from the right so a blank Address cannot shift it. */
function parseByHeader(output: string): TunTapInterfaceStats {
  const lines = output.trim().split('\n');
  const names = (lines[0] ?? '').trim().split(/\s+/);
  const values = (lines[1] ?? '').trim().split(/\s+/);
  const column = (name: string): number =>
    parseInt(values[values.length - (names.length - names.indexOf(name))] ?? '', 10);
  return {
    rxBytes: column('Ibytes'),
    txBytes: column('Obytes'),
    rxPackets: column('Ipkts'),
    txPackets: column('Opkts'),
    rxErrors: column('Ierrs'),
    txErrors: column('Oerrs'),
  };
}

/** Runs `fn` with a stub `netstat` on PATH that prints `output`. */
async function withNetstatStub<T>(output: string, fn: () => Promise<T>): Promise<T> {
  const stubDir = mkdtempSync(join(tmpdir(), 'netstat-stub-'));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(stubDir, 'utun.netstat'), output);
    const stub = join(stubDir, 'netstat');
    writeFileSync(stub, `#!/bin/sh\nexec cat '${join(stubDir, 'utun.netstat')}'\n`);
    chmodSync(stub, 0o755);
    process.env.PATH = `${stubDir}${delimiter}${originalPath ?? ''}`;
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    rmSync(stubDir, {recursive: true, force: true});
  }
}

function readLiveNetstat(interfaceName: string): string {
  return execFileSync('netstat', ['-I', interfaceName, '-b'], {encoding: 'utf8'});
}

/** First utun interface whose counters are non-zero, so a column shift is visible. */
function findUtunWithTraffic(): string | undefined {
  const interfaces = execFileSync('ifconfig', ['-l'], {encoding: 'utf8'}).trim().split(/\s+/);
  return interfaces
    .filter((name) => /^utun\d+$/.test(name))
    .find((name) => Object.values(parseByHeader(readLiveNetstat(name))).some((value) => value > 0));
}

describe('DarwinTunTapPlatform.getStats', () => {
  it(
    'maps utun netstat columns by header, not by fixed index',
    {skip: process.platform === 'win32' && 'needs a POSIX shell for the netstat stub'},
    async () => {
      const stats = await withNetstatStub(UTUN_NETSTAT_OUTPUT, () => new DarwinTunTapPlatform().getStats('utun0'));
      assert.deepStrictEqual(stats, parseByHeader(UTUN_NETSTAT_OUTPUT));
    },
  );

  it(
    'agrees with the live netstat for a real utun interface',
    {skip: process.platform !== 'darwin' && 'macOS only'},
    async (t) => {
      const interfaceName = findUtunWithTraffic();
      if (!interfaceName) {
        t.skip('no utun interface with traffic on this machine');
        return;
      }
      const before = parseByHeader(readLiveNetstat(interfaceName));
      const stats = await new DarwinTunTapPlatform().getStats(interfaceName);
      const after = parseByHeader(readLiveNetstat(interfaceName));
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        t.skip(`counters on ${interfaceName} changed during the test`);
        return;
      }
      assert.deepStrictEqual(stats, before, `${interfaceName} netstat row:\n${readLiveNetstat(interfaceName)}`);
    },
  );
});
