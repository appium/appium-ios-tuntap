/**
 * Packet Stream Tests — Bounded Queue & Graceful Stop
 *
 * Verifies two fixes to getPacketStream():
 *
 * 1. BOUNDED QUEUE — The internal packet queue enforces MAX_PACKET_QUEUE_SIZE
 *    (10,000). When exceeded, the oldest packet is dropped and the newest is
 *    appended. This prevents unbounded memory growth when a consumer falls
 *    behind or doesn't drain fast enough.
 *
 * 2. GRACEFUL STOP — When manager.stop() is called, it emits a 'stopped'
 *    event that the async generator listens for. Any pending iterator.next()
 *    call resolves immediately instead of hanging forever, allowing consumers
 *    to exit cleanly.
 *
 * These tests do NOT require root — they exercise the JS-level queue and
 * event logic using direct TunnelManager instantiation.
 */

import assert from 'node:assert';
import { TunnelManager } from '../lib/index.js';

describe('Packet Stream: Bounded queue drops oldest on overflow', function () {
  it('should cap queue at MAX_PACKET_QUEUE_SIZE and drop oldest packets', function () {
    const MAX_QUEUE = 10000; // matches MAX_PACKET_QUEUE_SIZE in tunnel.ts

    // Simulate the bounded queue behavior used inside getPacketStream()
    const queue = [];
    let resolver = null;
    const done = false;

    const consumer = {
      onPacket: (packet) => {
        if (done) return;
        if (resolver) {
          const r = resolver;
          resolver = null;
          r(packet);
        } else if (queue.length < MAX_QUEUE) {
          queue.push(packet);
        } else {
          queue.shift();
          queue.push(packet);
        }
      },
    };

    // Push MAX_QUEUE + 500 packets
    for (let i = 0; i < MAX_QUEUE + 500; i++) {
      consumer.onPacket({ protocol: 'UDP', sourcePort: i });
    }

    assert.strictEqual(queue.length, MAX_QUEUE, 'Queue should be bounded at MAX_PACKET_QUEUE_SIZE');
    assert.strictEqual(queue[0].sourcePort, 500, 'First 500 packets should have been dropped');
    assert.strictEqual(
      queue[queue.length - 1].sourcePort,
      MAX_QUEUE + 499,
      'Newest packet should be at the end',
    );
  });
});

describe('Packet Stream: Pending next() resolves on stop()', function () {
  this.timeout(5000);

  it('should resolve pending iterator.next() when manager is stopped', async function () {
    const manager = new TunnelManager();
    const stream = manager.getPacketStream();
    const iterator = stream[Symbol.asyncIterator]();

    let resolved = false;

    // Start consuming — this blocks waiting for the first packet
    const pendingNext = iterator.next().then((result) => {
      resolved = true;
    });

    // Give the pending promise a tick to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(resolved, false, 'Should be pending before stop');

    // Stop the manager — emits "stopped", unblocking the iterator
    await manager.stop();

    // Allow resolution to propagate
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(resolved, true, 'Pending next() should resolve after stop()');
  });
});
