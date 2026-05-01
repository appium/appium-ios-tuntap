import type {ExecException} from 'node:child_process';

import {TunTapError} from '../errors.js';
import {log} from '../logger.js';
import {assertAdminOnWindows} from './require-admin.js';
import {execFileAsync} from './exec.js';
import type {TunTapInterfaceStats, TunTapPlatform} from './types.js';

/** Tightly-restricted character set for adapter names passed into PowerShell. */
const SAFE_NAME_RE = /^[A-Za-z0-9_\- ]+$/;

/** Phrases that indicate `netsh` could not find the requested route/address. */
const MISSING_TARGET_HINTS = [
  'element not found',
  'cannot find',
  'no matching',
  'does not exist',
  'not found',
];

/** Windows implementation backed by `netsh` for configuration/routing and
 *  PowerShell `Get-NetAdapterStatistics` for byte counters. */
export class WindowsTunTapPlatform implements TunTapPlatform {
  /** @inheritdoc */
  async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);

    try {
      await execFileAsync('netsh', [
        'interface',
        'ipv6',
        'add',
        'address',
        `interface=${interfaceName}`,
        `address=${address}/64`,
        'store=active',
      ]);
    } catch (err: unknown) {
      const message = (err as ExecException).message ?? '';
      if (!/already exists|object already/i.test(message)) {
        throw err;
      }
      log.warn(`Address ${address} may already be configured on ${interfaceName}`);
    }

    await execFileAsync('netsh', [
      'interface',
      'ipv6',
      'set',
      'subinterface',
      interfaceName,
      `mtu=${mtu}`,
      'store=active',
    ]);
  }

  /** @inheritdoc */
  async addRoute(interfaceName: string, destination: string): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);

    try {
      await execFileAsync('netsh', [
        'interface',
        'ipv6',
        'add',
        'route',
        destination,
        interfaceName,
        'store=active',
      ]);
    } catch (err: unknown) {
      const message = (err as ExecException).message ?? '';
      if (/already exists|object already/i.test(message)) {
        log.info(`Route to ${destination} already exists`);
        return;
      }
      throw err;
    }
  }

  /** @inheritdoc */
  async removeRoute(interfaceName: string, destination: string): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);

    try {
      await execFileAsync('netsh', [
        'interface',
        'ipv6',
        'delete',
        'route',
        destination,
        interfaceName,
        'store=active',
      ]);
    } catch (err: unknown) {
      if (isMissingTargetError(err)) {
        return;
      }
      throw err;
    }
  }

  /** @inheritdoc */
  async getStats(interfaceName: string): Promise<TunTapInterfaceStats> {
    assertSafeAdapterName(interfaceName);

    const script =
      `Get-NetAdapterStatistics -Name '${interfaceName}' ` +
      '| Select-Object ReceivedBytes,SentBytes,ReceivedUnicastPackets,' +
      'SentUnicastPackets,ReceivedDiscardedPackets,OutboundDiscardedPackets ' +
      '| ConvertTo-Json -Compress';
    const {stdout} = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new TunTapError(`Failed to parse Get-NetAdapterStatistics output: ${stdout.trim()}`);
    }

    const num = (key: string): number => {
      const value = parsed[key];
      const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      rxBytes: num('ReceivedBytes'),
      rxPackets: num('ReceivedUnicastPackets'),
      rxErrors: num('ReceivedDiscardedPackets'),
      txBytes: num('SentBytes'),
      txPackets: num('SentUnicastPackets'),
      txErrors: num('OutboundDiscardedPackets'),
    };
  }
}

/** Validates an adapter name before embedding in a PowerShell expression. */
function assertSafeAdapterName(interfaceName: string): void {
  if (!SAFE_NAME_RE.test(interfaceName)) {
    throw new TunTapError(
      `Refusing to use adapter name with unsupported characters: ${JSON.stringify(interfaceName)}`,
    );
  }
}

function isMissingTargetError(err: unknown): boolean {
  const message = String((err as ExecException | undefined)?.message ?? '').toLowerCase();
  return MISSING_TARGET_HINTS.some((hint) => message.includes(hint));
}
