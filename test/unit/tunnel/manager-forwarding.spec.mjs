import assert from 'node:assert';
import {Buffer} from 'node:buffer';
import {describe, it} from 'node:test';

import {IPV6_HEADER_SIZE, IPV6_VERSION} from '../../../lib/tunnel/constants.js';

/** Mirror of native ipv6_frame::FrameLength for unit tests. */
function frameLength(buffer) {
  if (buffer.length < IPV6_HEADER_SIZE) {
    return 0;
  }
  if (((buffer[0] >> 4) & 0x0f) !== IPV6_VERSION) {
    return 1;
  }
  const payloadLength = buffer.readUInt16BE(4);
  const total = IPV6_HEADER_SIZE + payloadLength;
  if (buffer.length < total) {
    return 0;
  }
  return total;
}

describe('IPv6 frame length', () => {
  it('returns 0 when buffer is shorter than header', () => {
    assert.strictEqual(frameLength(Buffer.alloc(20)), 0);
  });

  it('returns full frame length for a complete packet', () => {
    const packet = Buffer.alloc(1280);
    packet[0] = 0x60;
    packet.writeUInt16BE(1240, 4);
    assert.strictEqual(frameLength(packet), 1280);
  });

  it('returns 1 for resync on non-IPv6 version nibble', () => {
    const packet = Buffer.alloc(1280);
    packet[0] = 0x40;
    assert.strictEqual(frameLength(packet), 1);
  });
});
