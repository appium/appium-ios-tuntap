/**
 * TunnelManager Lifecycle Tests — Stop, Cleanup & Signal Handlers
 *
 * Verifies three critical fixes to TunnelManager:
 *
 * 1. stop() emits a 'stopped' event before clearing state, which unblocks
 *    any pending getPacketStream() consumers and prevents resource leaks.
 *
 * 2. The library no longer installs global SIGINT/SIGTERM handlers that call
 *    process.exit(). Libraries must not hijack process signals — that is the
 *    application's responsibility. The fix removed setupSignalHandlers() and
 *    all process.on('SIGINT'/'SIGTERM') calls.
 *
 * These tests do NOT require root — they instantiate TunnelManager without
 * opening a real TUN device.
 */

import assert from 'node:assert';
import { TunnelManager } from '../lib/index.js';

describe('TunnelManager: stop() emits "stopped" and clears state', function () {
  it('should emit the stopped event and remove all listeners', async function () {
    const manager = new TunnelManager();

    let stoppedEmitted = false;
    manager.on('stopped', () => {
      stoppedEmitted = true;
    });
    manager.addPacketConsumer({ onPacket: () => {} });

    await manager.stop();

    assert.strictEqual(stoppedEmitted, true, '"stopped" event should be emitted');
    assert.strictEqual(manager.listenerCount('data'), 0, 'All "data" listeners should be removed');
    assert.strictEqual(manager.listenerCount('stopped'), 0, 'All "stopped" listeners should be removed');
  });
});

describe('TunnelManager: No global SIGINT/SIGTERM handlers from library', function () {
  it('should not add signal listeners when creating TunnelManager', function () {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const manager = new TunnelManager();

    const sigintAfter = process.listenerCount('SIGINT');
    const sigtermAfter = process.listenerCount('SIGTERM');

    assert.strictEqual(sigintAfter, sigintBefore, 'Should not add SIGINT listeners');
    assert.strictEqual(sigtermAfter, sigtermBefore, 'Should not add SIGTERM listeners');

    manager.stop();
  });
});
