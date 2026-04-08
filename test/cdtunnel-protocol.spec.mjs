/**
 * CDTunnel Protocol Tests — Handshake Parsing, Size Limits & Pipelining
 *
 * Verifies the exchangeCoreTunnelParameters() function that implements
 * Apple's CDTunnel handshake for iOS 17+ device communication:
 *
 * 1. OVERSIZED RESPONSE — Rejects responses whose declared payload length
 *    exceeds MAX_HANDSHAKE_RESPONSE_SIZE (8,192 bytes). The check validates
 *    the declared size from the header, NOT the total bytes buffered, so
 *    pipelined tunnel traffic doesn't cause false rejections.
 *
 * 2. PIPELINED DATA — When the handshake response and subsequent IPv6 tunnel
 *    traffic arrive in the same TCP segment, excess bytes are preserved via
 *    socket.unshift() for startForwarding() to consume later.
 *
 * 3. INVALID MAGIC — Rejects responses that don't start with "CDTunnel",
 *    detecting corrupted or non-conforming peers early.
 *
 * 4. INVALID JSON — Rejects responses with syntactically invalid JSON payloads,
 *    providing a clear error instead of an unhandled exception.
 *
 * 5. VALID RESPONSE — Correctly parses a well-formed CDTunnel response,
 *    extracting clientParameters, serverAddress, and serverRSDPort.
 *
 * These tests do NOT require root — they use mock sockets to simulate the
 * remote peer without any real device or network connection.
 */

import assert from 'node:assert';
import { exchangeCoreTunnelParameters } from '../lib/index.js';
import { createMockSocket } from './utils.mjs';

function buildCDTunnelPacket(jsonPayload) {
  const jsonBuf = Buffer.from(JSON.stringify(jsonPayload));
  const magic = Buffer.from('CDTunnel');
  const lengthBuf = Buffer.alloc(2);
  lengthBuf.writeUInt16BE(jsonBuf.length);
  return Buffer.concat([magic, lengthBuf, jsonBuf]);
}

describe('CDTunnel Protocol: Reject oversized handshake responses', function () {
  this.timeout(10000);

  it('should reject when declared payload exceeds MAX_HANDSHAKE_RESPONSE_SIZE', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const magic = Buffer.from('CDTunnel');
    const lengthBuf = Buffer.alloc(2);
    lengthBuf.writeUInt16BE(60000);
    const partialPayload = Buffer.alloc(100, 0x41);
    socket.emit('data', Buffer.concat([magic, lengthBuf, partialPayload]));

    await assert.rejects(promise, (err) => {
      assert.ok(
        err.message.includes('exceeds maximum size'),
        `Expected "exceeds maximum size" error, got: ${err.message}`,
      );
      return true;
    });
  });
});

describe('CDTunnel Protocol: Preserve pipelined tunnel traffic', function () {
  this.timeout(10000);

  it('should unshift excess bytes when handshake + tunnel data arrive together', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const fakeIPv6Packet = Buffer.alloc(80, 0x00);
    fakeIPv6Packet[0] = 0x60;

    const handshake = buildCDTunnelPacket({
      clientParameters: { address: 'fd00::1', mtu: 1500 },
      serverAddress: 'fd00::2',
      serverRSDPort: 58783,
    });
    socket.emit('data', Buffer.concat([handshake, fakeIPv6Packet]));

    const result = await promise;
    assert.strictEqual(result.clientParameters.address, 'fd00::1');
    assert.strictEqual(result.serverRSDPort, 58783);

    assert.strictEqual(socket.unshiftedData.length, 1, 'Should have unshifted excess data');
    assert.strictEqual(
      socket.unshiftedData[0].length,
      fakeIPv6Packet.length,
      'Unshifted data should match the pipelined packet size',
    );
    assert.strictEqual(
      socket.unshiftedData[0][0],
      0x60,
      'Unshifted data should start with IPv6 version byte',
    );
  });

  it('should not unshift when handshake response has no trailing data', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const handshake = buildCDTunnelPacket({
      clientParameters: { address: 'fd00::1', mtu: 1500 },
      serverAddress: 'fd00::2',
      serverRSDPort: 58783,
    });
    socket.emit('data', handshake);

    const result = await promise;
    assert.strictEqual(result.serverAddress, 'fd00::2');
    assert.strictEqual(socket.unshiftedData.length, 0, 'Should not unshift when no excess data');
  });
});

describe('CDTunnel Protocol: Reject invalid magic header', function () {
  this.timeout(10000);

  it('should reject responses that do not start with "CDTunnel"', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const badMagic = Buffer.from('XXXXXXXX');
    const lengthBuf = Buffer.alloc(2);
    lengthBuf.writeUInt16BE(2);
    socket.emit('data', Buffer.concat([badMagic, lengthBuf, Buffer.from('{}')]));

    await assert.rejects(promise, (err) => {
      assert.ok(err.message.includes('Invalid packet format'));
      return true;
    });
  });
});

describe('CDTunnel Protocol: Reject invalid JSON payload', function () {
  this.timeout(10000);

  it('should reject syntactically invalid JSON in the response body', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const magic = Buffer.from('CDTunnel');
    const invalidJson = Buffer.from('{not valid json');
    const lengthBuf = Buffer.alloc(2);
    lengthBuf.writeUInt16BE(invalidJson.length);

    socket.emit('data', Buffer.concat([magic, lengthBuf, invalidJson]));

    await assert.rejects(promise, (err) => {
      assert.ok(err.message.includes('Invalid JSON response'));
      return true;
    });
  });
});

describe('CDTunnel Protocol: Parse valid response correctly', function () {
  this.timeout(10000);

  it('should extract clientParameters, serverAddress, and serverRSDPort', async function () {
    const socket = createMockSocket();
    const promise = exchangeCoreTunnelParameters(socket);

    const handshake = buildCDTunnelPacket({
      clientParameters: { address: 'fd00::1', mtu: 1500 },
      serverAddress: 'fd00::2',
      serverRSDPort: 58783,
    });
    socket.emit('data', handshake);

    const result = await promise;
    assert.strictEqual(result.clientParameters.address, 'fd00::1');
    assert.strictEqual(result.serverAddress, 'fd00::2');
    assert.strictEqual(result.serverRSDPort, 58783);
  });
});
