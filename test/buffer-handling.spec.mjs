/**
 * Buffer Handling Tests — Memory Leak Prevention
 *
 * Verifies that the processBuffer() fix in tunnel.ts correctly detaches
 * remaining data from the original large buffer.
 *
 * THE PROBLEM:
 *   Buffer.slice() (deprecated) returns a view into the same underlying
 *   ArrayBuffer. If a 1MB buffer is sliced to keep only the last 10 bytes,
 *   the entire 1MB ArrayBuffer stays alive in memory because the 10-byte
 *   slice still references it. Over time this creates a hidden memory leak.
 *
 * THE FIX:
 *   Replaced `this.buffer = this.buffer.slice(offset)` with
 *   `this.buffer = Buffer.from(this.buffer.subarray(offset))` which creates
 *   a fresh copy with its own small ArrayBuffer, allowing the GC to collect
 *   the original large buffer.
 *
 * These tests do NOT require root — they exercise pure Buffer operations.
 */

import assert from 'node:assert';

describe('Buffer Handling: Buffer.from(subarray) copies data, breaks reference', function () {
  it('should not retain reference to original large buffer', function () {
    const largeBuffer = Buffer.alloc(1024 * 1024); // 1MB
    const copied = Buffer.from(largeBuffer.subarray(1024 * 1024 - 10));

    assert.strictEqual(copied.length, 10, 'Copied buffer should have exactly 10 bytes');

    // The copy has its own ArrayBuffer. V8 may round up the backing store
    // (e.g. 8KB minimum), but it must be far smaller than the original 1MB.
    assert.ok(
      copied.buffer.byteLength < 1024 * 1024,
      `Copied buffer backing store (${copied.buffer.byteLength}) should be much smaller than original 1MB`,
    );
  });

  it('should confirm deprecated slice() retains the original reference', function () {
    const largeBuffer = Buffer.alloc(1024 * 1024); // 1MB

    const sliced = largeBuffer.slice(1024 * 1024 - 10);

    assert.strictEqual(sliced.length, 10);

    // slice() shares the ArrayBuffer — full 1MB is still pinned
    assert.strictEqual(
      sliced.buffer.byteLength,
      1024 * 1024,
      'Sliced buffer should still reference the full 1MB ArrayBuffer',
    );
  });
});
