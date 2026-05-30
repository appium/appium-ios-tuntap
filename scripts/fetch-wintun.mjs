// Maintainer-only helper that refreshes the bundled WinTun binaries committed
// under vendor/wintun/. The npm `install` hook does NOT invoke this script —
// the package ships with the official signed DLLs already checked in. Run
// `npm run refresh:wintun -- --version <semver>` to pull a different release.

import {fs, logger, net, tempDir, zip} from '@appium/support';
import {Command} from 'commander';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const log = logger.getLogger('refresh-wintun');

const DEFAULT_WINTUN_VERSION = '0.14.1';
const BUNDLED_ARCHES = ['amd64', 'arm64', 'x86', 'arm'];

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(rootDir, 'vendor', 'wintun');

async function deployDll(arch, extractDir) {
  const destDir = join(vendorDir, 'bin', arch);
  await fs.mkdir(destDir, {recursive: true});
  const src = join(extractDir, 'wintun', 'bin', arch, 'wintun.dll');
  const dest = join(destDir, 'wintun.dll');
  await fs.copyFile(src, dest);
  log.info(`wintun.dll (${arch}) -> ${dest}`);
}

async function deployLicense(extractDir) {
  const src = join(extractDir, 'wintun', 'LICENSE.txt');
  const dest = join(vendorDir, 'LICENSE.txt');
  await fs.copyFile(src, dest);
  log.info(`LICENSE.txt -> ${dest}`);
}

async function refreshWintun(version) {
  const url = `https://www.wintun.net/builds/wintun-${version}.zip`;
  const tmpDir = await tempDir.openDir();
  try {
    const zipPath = join(tmpDir, 'wintun.zip');
    const extractDir = join(tmpDir, 'out');
    await fs.mkdir(extractDir, {recursive: true});

    log.info(`Downloading WinTun ${version}...`);
    await net.downloadFile(url, zipPath);
    await zip.extractAllTo(zipPath, extractDir);

    await fs.mkdir(vendorDir, {recursive: true});
    await Promise.all([
      ...BUNDLED_ARCHES.map((arch) => deployDll(arch, extractDir)),
      deployLicense(extractDir),
    ]);
  } finally {
    await fs.rimraf(tmpDir);
  }
}

const program = new Command();
program
  .name('refresh-wintun')
  .description('Refresh the bundled WinTun binaries under vendor/wintun/')
  .option(
    '-v, --version <semver>',
    'WinTun release version to download',
    DEFAULT_WINTUN_VERSION,
  )
  .action(async (options) => {
    await refreshWintun(options.version);
  });

await program.parseAsync(process.argv);
