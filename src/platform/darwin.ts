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

    const [ipkts, ierrs, ibytes, opkts, oerrs, obytes] = lines[1].trim().split(/\s+/).slice(-7, -1);
    return {
      rxPackets: parseInt(ipkts, 10) || 0,
      rxErrors: parseInt(ierrs, 10) || 0,
      rxBytes: parseInt(ibytes, 10) || 0,
      txPackets: parseInt(opkts, 10) || 0,
      txErrors: parseInt(oerrs, 10) || 0,
      txBytes: parseInt(obytes, 10) || 0,
    };
  }
}
