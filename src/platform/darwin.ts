import {TunTapError} from '../errors.js';
import {execFileAsync} from './exec.js';
import {assertEffectiveRoot} from './require-root.js';
import type {TunTapInterfaceStats, TunTapPlatform} from './types.js';

/** macOS implementation using `ifconfig`, `route`, and `netstat`. */
export class DarwinTunTapPlatform implements TunTapPlatform {
  /** @inheritdoc */
  async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('ifconfig', [interfaceName, 'inet6', address, 'prefixlen', '64', 'up']);
    await execFileAsync('ifconfig', [interfaceName, 'mtu', String(mtu)]);
  }

  /** @inheritdoc */
  async addRoute(interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('route', ['-n', 'add', '-inet6', destination, '-interface', interfaceName]);
  }

  /** @inheritdoc */
  async removeRoute(_interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('route', ['-n', 'delete', '-inet6', destination]);
  }

  /** @inheritdoc */
  async getStats(interfaceName: string): Promise<TunTapInterfaceStats> {
    const {stdout} = await execFileAsync('netstat', ['-I', interfaceName, '-b']);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      throw new TunTapError('Unexpected netstat output');
    }

    const stats = lines[1].split(/\s+/);
    return {
      rxPackets: parseInt(stats[4], 10) || 0,
      rxErrors: parseInt(stats[5], 10) || 0,
      rxBytes: parseInt(stats[6], 10) || 0,
      txPackets: parseInt(stats[7], 10) || 0,
      txErrors: parseInt(stats[8], 10) || 0,
      txBytes: parseInt(stats[9], 10) || 0,
    };
  }
}
