import assert from 'node:assert';
import {describe, it} from 'node:test';

import {appendBuffer} from '../../lib/tunnel/buffer-utils.js';

describe('appendBuffer', () => {
  it('returns existing when chunk is empty', () => {
    const existing = Buffer.from('abc');
    assert.strictEqual(appendBuffer(existing, Buffer.alloc(0)), existing);
  });

  it('copies chunk when existing is empty', () => {
    const chunk = Buffer.from([1, 2, 3]);
    const out = appendBuffer(Buffer.alloc(0), chunk);
    assert.ok(out.equals(chunk));
    assert.notStrictEqual(out, chunk);
  });

  it('concatenates without mutating inputs', () => {
    const a = Buffer.from('hello');
    const b = Buffer.from('world');
    const out = appendBuffer(a, b);
    assert.strictEqual(out.toString(), 'helloworld');
    assert.strictEqual(a.toString(), 'hello');
    assert.strictEqual(b.toString(), 'world');
  });

  it('reuses existing buffer when appending an empty chunk', () => {
    const existing = Buffer.alloc(4096);
    assert.strictEqual(appendBuffer(existing, Buffer.alloc(0)), existing);
  });
});
