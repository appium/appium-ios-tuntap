import type {ExecException} from 'node:child_process';
import {performance} from 'node:perf_hooks';

import {TunTapError} from '../errors.js';
import {log} from '../logger.js';
import {tunDebug} from '../tunnel/debug-log.js';
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

const ADDRESS_READY_TIMEOUT_MS = 5000;

/** Windows implementation backed by `netsh` for configuration/routing and
 *  PowerShell `Get-NetAdapterStatistics` for byte counters. */
export class WindowsTunTapPlatform implements TunTapPlatform {
  /** @inheritdoc */
  async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);
    tunDebug(`[win] configure: interface=${interfaceName} address=${address} mtu=${mtu}`);

    await addIpv6Address(interfaceName, address);
    await waitForIpv6AddressReady(interfaceName, address);
    await setIpv6Mtu(interfaceName, mtu);
  }

  /** @inheritdoc */
  async addRoute(interfaceName: string, destination: string): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);

    tunDebug(`[win] addRoute: interface=${interfaceName} destination=${destination}`);

    await addIpv6Route(interfaceName, destination);

    // WinTun presents as an Ethernet adapter, so Windows requires Neighbor
    // Discovery (NDP) before it will send packets through the interface.
    // For /128 host routes we seed a static neighbor entry so NDP is bypassed
    // and the first connection attempt is not silently dropped.
    if (destination.endsWith('/128')) {
      const address = destination.slice(0, -4);
      await addStaticNeighbor(interfaceName, address);
    }
  }

  /** @inheritdoc */
  async removeRoute(interfaceName: string, destination: string): Promise<void> {
    await assertAdminOnWindows();
    assertSafeAdapterName(interfaceName);
    await deleteIpv6Route(interfaceName, destination);
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

async function addIpv6Address(interfaceName: string, address: string): Promise<void> {
  try {
    const r = await execFileAsync('netsh', [
      'interface',
      'ipv6',
      'add',
      'address',
      `interface=${interfaceName}`,
      `address=${address}/64`,
      'store=active',
    ]);
    tunDebug(`[win] add address ok: ${r.stdout.trim() || '(no output)'}`);
  } catch (err: unknown) {
    const message = (err as ExecException).message ?? '';
    log.warn(`[win] add address err: ${message}`);
    if (!/already exists|object already/i.test(message)) {
      throw err;
    }
    log.warn(`Address ${address} may already be configured on ${interfaceName}`);
  }
}

async function waitForIpv6AddressReady(interfaceName: string, address: string): Promise<void> {
  const deadline = performance.now() + ADDRESS_READY_TIMEOUT_MS;
  let lastState = '';

  while (performance.now() < deadline) {
    const escapedName = interfaceName.replace(/'/g, "''");
    const escapedAddress = address.replace(/'/g, "''");
    const script =
      `Get-NetIPAddress -InterfaceAlias '${escapedName}' -IPAddress '${escapedAddress}' ` +
      '-AddressFamily IPv6 -ErrorAction SilentlyContinue | ' +
      'Select-Object -First 1 -ExpandProperty AddressState';
    const {stdout} = await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    lastState = stdout.trim();
    if (/^Preferred$/i.test(lastState)) {
      tunDebug(`[win] address ready: ${address} state=${lastState}`);
      return;
    }
    tunDebug(`[win] waiting for address: ${address} state=${lastState || '(not found)'}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new TunTapError(
    `[win] address ${address} did not become Preferred (last state: ${lastState || 'not found'})`,
  );
}

async function setIpv6Mtu(interfaceName: string, mtu: number): Promise<void> {
  try {
    const r = await execFileAsync('netsh', [
      'interface',
      'ipv6',
      'set',
      'subinterface',
      interfaceName,
      `mtu=${mtu}`,
      'store=active',
    ]);
    tunDebug(`[win] set mtu ok: ${r.stdout.trim() || '(no output)'}`);
  } catch (err: unknown) {
    log.warn(`[win] set mtu err: ${(err as ExecException).message ?? err}`);
    throw err;
  }
}

async function addIpv6Route(interfaceName: string, destination: string): Promise<void> {
  try {
    const r = await execFileAsync('netsh', [
      'interface',
      'ipv6',
      'add',
      'route',
      destination,
      interfaceName,
      'store=active',
    ]);
    tunDebug(`[win] add route ok: ${r.stdout.trim() || '(no output)'}`);
  } catch (err: unknown) {
    const message = (err as ExecException).message ?? '';
    log.warn(`[win] add route err: ${message}`);
    if (/already exists|object already/i.test(message)) {
      tunDebug(`Route to ${destination} already exists`);
      return;
    }
    throw err;
  }
}

async function deleteIpv6Route(interfaceName: string, destination: string): Promise<void> {
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

async function addStaticNeighbor(interfaceName: string, address: string): Promise<void> {
  tunDebug(`[win] addStaticNeighbor: interface=${interfaceName} address=${address}`);
  try {
    const r = await execFileAsync('netsh', [
      'interface',
      'ipv6',
      'add',
      'neighbor',
      interfaceName,
      address,
      '00-00-00-00-00-01',
      'store=active',
    ]);
    tunDebug(`[win] add neighbor ok: ${r.stdout.trim() || '(no output)'}`);
  } catch (err) {
    const msg = (err as ExecException).message ?? String(err);
    log.warn(`[win] add neighbor err: ${msg}`);
  }
}
