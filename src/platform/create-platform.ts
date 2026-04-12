import {DarwinTunTapPlatform} from './darwin.js';
import {LinuxTunTapPlatform} from './linux.js';
import type {TunTapPlatform} from './types.js';
import {UnsupportedTunTapPlatform} from './unsupported.js';

/** @internal Built-in {@link TunTapPlatform} for a Node `process.platform` value. */
export function createTunTapPlatform(platform: NodeJS.Platform): TunTapPlatform {
  switch (platform) {
    case 'darwin':
      return new DarwinTunTapPlatform();
    case 'linux':
      return new LinuxTunTapPlatform();
    default:
      return new UnsupportedTunTapPlatform(platform);
  }
}
