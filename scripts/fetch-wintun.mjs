import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const WINTUN_VERSION = '0.14.1';
const WINTUN_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`;

if (process.platform !== 'win32') process.exit(0);

const archMap = {x64: 'amd64', ia32: 'x86', arm64: 'arm64', arm: 'arm'};
const wintunArch = archMap[process.arch] ?? 'amd64';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildRelease = join(rootDir, 'build', 'Release');
const prebuildDir = join(rootDir, 'prebuilds', `win32-${process.arch}`);

const destinations = [];
for (const dir of [buildRelease, prebuildDir]) {
  if (existsSync(dir)) destinations.push(dir);
}
if (destinations.length === 0) {
  mkdirSync(buildRelease, {recursive: true});
  destinations.push(buildRelease);
}

if (destinations.every((d) => existsSync(join(d, 'wintun.dll')))) {
  console.log('wintun.dll already in place, skipping download.');
  process.exit(0);
}

const tmpDir = join(tmpdir(), `wintun-${randomBytes(4).toString('hex')}`);
const zipPath = join(tmpDir, 'wintun.zip');
const extractDir = join(tmpDir, 'out');

mkdirSync(tmpDir, {recursive: true});

console.log(`Downloading WinTun ${WINTUN_VERSION}...`);
const res = await fetch(WINTUN_URL);
if (!res.ok) throw new Error(`Failed to download WinTun: HTTP ${res.status}`);
writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
  ],
  {stdio: 'inherit'},
);

const dllSrc = join(extractDir, 'wintun', 'bin', wintunArch, 'wintun.dll');

try {
  for (const dest of destinations) {
    copyFileSync(dllSrc, join(dest, 'wintun.dll'));
    console.log(`wintun.dll -> ${dest}`);
  }
} finally {
  rmSync(tmpDir, {recursive: true, force: true});
}
