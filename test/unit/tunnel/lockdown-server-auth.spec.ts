import assert from 'node:assert';
import {once} from 'node:events';
import {connect} from 'node:net';
import {describe, it} from 'node:test';
import {createServer} from 'node:tls';

import {TunnelForwarder} from '../../../src/index.js';
import {TEST_TLS_CERT, TEST_TLS_KEY, TEST_TLS_UNTRUSTED_CERT, TEST_TLS_UNTRUSTED_KEY} from '../../fixtures/tls.js';

describe(
  'lockdown TLS server authentication',
  {skip: process.platform === 'win32' && 'POSIX fd handoff only', timeout: 20000},
  () => {
    it('rejects a server whose certificate is not the paired device', async () => {
      const server = createServer(
        {cert: TEST_TLS_UNTRUSTED_CERT, key: TEST_TLS_UNTRUSTED_KEY, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2'},
        (socket) => socket.on('error', () => {}),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const {port} = server.address() as {port: number};

      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      const forwarder = new TunnelForwarder();
      try {
        await assert.rejects(
          forwarder.connect(socket, {cert: TEST_TLS_CERT, key: TEST_TLS_KEY, deviceCert: TEST_TLS_CERT}),
          /Device TLS certificate does not match the pair record/,
        );
      } finally {
        forwarder.stop();
        server.close();
      }
    });
  },
);
