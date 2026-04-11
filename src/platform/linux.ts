import type { ExecException } from 'node:child_process';

import { log } from '../logger.js';
import { TunTapError } from '../errors.js';
import { execFileAsync } from './exec.js';
import { assertEffectiveRoot } from './require-root.js';
import type { TunTapInterfaceStats, TunTapPlatform } from './types.js';

/** Linux implementation using `ip` from iproute2. */
export class LinuxTunTapPlatform implements TunTapPlatform {
    /** @inheritdoc */
    async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
        assertEffectiveRoot();
        try {
            await execFileAsync('which', ['ip']);
        } catch {
            throw new TunTapError(
                'The "ip" command is not available. Please install iproute2 (e.g., sudo apt install iproute2)',
            );
        }

        try {
            await execFileAsync('ip', ['-6', 'addr', 'add', `${address}/64`, 'dev', interfaceName]);
        } catch (err: unknown) {
            // `util.promisify(execFile)` rejects with `ExecException` (extends `Error`; adds `stderr`, `code`, …).
            const { message } = err as ExecException;
            if (!message.includes('File exists')) {
                throw err;
            }
            log.warn(`Address ${address} may already be configured on ${interfaceName}`);
        }

        await execFileAsync('ip', ['link', 'set', 'dev', interfaceName, 'up', 'mtu', String(mtu)]);
    }

    /** @inheritdoc */
    async addRoute(interfaceName: string, destination: string): Promise<void> {
        assertEffectiveRoot();
        try {
            await execFileAsync('ip', ['-6', 'route', 'add', destination, 'dev', interfaceName]);
        } catch (err: unknown) {
            const { message } = err as ExecException;
            if (message.includes('File exists')) {
                log.info(`Route to ${destination} already exists`);
                return;
            }
            throw err;
        }
    }

    /** @inheritdoc */
    async removeRoute(interfaceName: string, destination: string): Promise<void> {
        assertEffectiveRoot();
        await execFileAsync('ip', ['-6', 'route', 'del', destination, 'dev', interfaceName]);
    }

    /** @inheritdoc */
    async getStats(interfaceName: string): Promise<TunTapInterfaceStats> {
        const { stdout } = await execFileAsync('ip', ['-s', 'link', 'show', interfaceName]);
        const lines = stdout.trim().split('\n');

        const rxIndex = lines.findIndex((line) => line.includes('RX:'));
        const txIndex = lines.findIndex((line) => line.includes('TX:'));

        if (rxIndex === -1 || txIndex === -1) {
            throw new TunTapError('Could not parse interface statistics');
        }

        const rxLine = lines[rxIndex + 1]?.trim();
        const txLine = lines[txIndex + 1]?.trim();
        if (!rxLine || !txLine) {
            throw new TunTapError('Could not parse interface statistics: missing data lines');
        }

        const rxStats = rxLine.split(/\s+/);
        const txStats = txLine.split(/\s+/);
        if (rxStats.length < 3 || txStats.length < 3) {
            throw new TunTapError('Could not parse interface statistics: unexpected format');
        }

        return {
            rxBytes: parseInt(rxStats[0], 10) || 0,
            rxPackets: parseInt(rxStats[1], 10) || 0,
            rxErrors: parseInt(rxStats[2], 10) || 0,
            txBytes: parseInt(txStats[0], 10) || 0,
            txPackets: parseInt(txStats[1], 10) || 0,
            txErrors: parseInt(txStats[2], 10) || 0,
        };
    }
}
