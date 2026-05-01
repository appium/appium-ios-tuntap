import {DarwinTunTapPlatform} from './darwin.js';
import {LinuxTunTapPlatform} from './linux.js';
import type {TunTapPlatform} from './types.js';
import {UnsupportedTunTapPlatform} from './unsupported.js';
import {WindowsTunTapPlatform} from './windows.js';

/** @internal Built-in {@link TunTapPlatform} for a Node `process.platform` value. */
export function createTunTapPlatform(platform: NodeJS.Platform): TunTapPlatform {
  switch (platform) {
    case 'darwin':
      return new DarwinTunTapPlatform();
    case 'linux':
      return new LinuxTunTapPlatform();
    case 'win32':
      return new WindowsTunTapPlatform();
    default:
      return new UnsupportedTunTapPlatform(platform);
  }
}
