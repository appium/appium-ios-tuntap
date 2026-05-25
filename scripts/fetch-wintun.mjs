// Maintainer-only helper that refreshes the bundled WinTun binaries committed
// under vendor/wintun/. The npm `install` hook does NOT invoke this script —
// the package ships with the official signed DLLs already checked in. Run
// `npm run refresh:wintun` after bumping `WINTUN_VERSION` to update them.

import {fs, logger, net, tempDir, zip} from '@appium/support';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const log = logger.getLogger('refresh-wintun');

const WINTUN_VERSION = '0.14.1';
const WINTUN_URL = `https://www.wintun.net/builds/wintun-${WINTUN_VERSION}.zip`;
const BUNDLED_ARCHES = ['amd64', 'arm64', 'x86', 'arm'];

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(rootDir, 'vendor', 'wintun');

const tmpDir = await tempDir.openDir();
try {
  const zipPath = join(tmpDir, 'wintun.zip');
  const extractDir = join(tmpDir, 'out');
  await fs.mkdir(extractDir, {recursive: true});

  log.info(`Downloading WinTun ${WINTUN_VERSION}...`);
  await net.downloadFile(WINTUN_URL, zipPath);
  await zip.extractAllTo(zipPath, extractDir);

  await fs.mkdir(vendorDir, {recursive: true});
  await Promise.all([
    ...BUNDLED_ARCHES.map(async (arch) => {
      const destDir = join(vendorDir, 'bin', arch);
      await fs.mkdir(destDir, {recursive: true});
      const src = join(extractDir, 'wintun', 'bin', arch, 'wintun.dll');
      const dest = join(destDir, 'wintun.dll');
      await fs.copyFile(src, dest);
      log.info(`wintun.dll (${arch}) -> ${dest}`);
    }),
    (async () => {
      const src = join(extractDir, 'wintun', 'LICENSE.txt');
      const dest = join(vendorDir, 'LICENSE.txt');
      await fs.copyFile(src, dest);
      log.info(`LICENSE.txt -> ${dest}`);
    })(),
  ]);
} finally {
  await fs.rimraf(tmpDir);
}
