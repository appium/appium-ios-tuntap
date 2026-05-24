/* eslint-disable no-console */
import { fs, net, system, zip } from '@appium/support';
import { mkdtemp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WINTUN_VERSION = '0.14.1';
const WINTUN_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`;

if (!system.isWindows()) {
  process.exit(0);
}

try {
  const archMap = { x64: 'amd64', ia32: 'x86', arm64: 'arm64', arm: 'arm' };
  const wintunArch = archMap[process.arch] ?? 'amd64';

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buildRelease = join(rootDir, 'build', 'Release');
  const prebuildDir = join(rootDir, 'prebuilds', `win32-${process.arch}`);

  const destinations = [];
  for (const dir of [buildRelease, prebuildDir]) {
    if (await fs.exists(dir)) {
      destinations.push(dir);
    }
  }
  if (destinations.length === 0) {
    await fs.mkdir(buildRelease, { recursive: true });
    destinations.push(buildRelease);
  }

  let allExist = true;
  for (const dest of destinations) {
    if (!(await fs.exists(join(dest, 'wintun.dll')))) {
      allExist = false;
      break;
    }
  }

  if (allExist) {
    console.log('wintun.dll already in place, skipping download.');
    process.exit(0);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'wintun-'));
  const zipPath = join(tmpDir, 'wintun.zip');
  const extractDir = join(tmpDir, 'out');

  try {
    await fs.mkdir(extractDir, { recursive: true });

    console.log(`Downloading WinTun ${WINTUN_VERSION}...`);
    await net.downloadFile(WINTUN_URL, zipPath);

    await zip.extractAllTo(zipPath, extractDir);

    const dllSrc = join(extractDir, 'wintun', 'bin', wintunArch, 'wintun.dll');

    for (const dest of destinations) {
      await fs.copyFile(dllSrc, join(dest, 'wintun.dll'));
      console.log(`wintun.dll -> ${dest}`);
    }
  } finally {
    await fs.rimraf(tmpDir);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
