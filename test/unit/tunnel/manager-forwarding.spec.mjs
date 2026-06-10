import assert from 'node:assert';
import {EventEmitter} from 'node:events';

import {
  DEFAULT_TUN_POLL_QUEUE_DEPTH,
  FAST_TUN_POLL_QUEUE_DEPTH,
  LARGE_TUN_POLL_BUFFER,
  MAX_TUN_POLL_BUFFER,
} from '../../../lib/tunnel/constants.js';
import {TunnelManager} from '../../../lib/tunnel/manager.js';

class MockTunTap {
  constructor() {
    this.name = 'utun-mock';
    this.pollBuffer = null;
    this.queueDepth = null;
    this.paused = false;
    this.callback = null;
  }

  open() {
    return true;
  }

  close() {}

  write() {
    return 0;
  }

  async configure() {}

  async addRoute() {}

  startPolling(callback, bufferSize, queueDepth) {
    this.callback = callback;
    this.pollBuffer = bufferSize;
    this.queueDepth = queueDepth;
  }

  pausePolling() {
    this.paused = true;
  }

  resumePolling() {
    this.paused = false;
  }
}

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableNeedDrain = false;
    this._writable = true;
  }

  setNoDelay() {}

  setKeepAlive() {}

  write(data) {
    this.emit('written', data);
    return this._writable;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

describe('TunnelManager forwarding', function () {
  it('uses a larger poll buffer and deeper queue when packet tap is off', function () {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();

    manager.tun = tun;
    manager.mtu = 1280;
    manager.startTunReadLoop(socket);

    assert.strictEqual(
      tun.pollBuffer,
      Math.min(MAX_TUN_POLL_BUFFER, Math.max(1280, LARGE_TUN_POLL_BUFFER)),
    );
    assert.strictEqual(tun.queueDepth, FAST_TUN_POLL_QUEUE_DEPTH);
  });

  it('uses MTU-sized poll buffer and default queue when packet tap is on', function () {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();

    manager.addPacketConsumer({onPacket: () => {}});
    manager.tun = tun;
    manager.mtu = 1280;
    manager.startTunReadLoop(socket);

    assert.strictEqual(tun.pollBuffer, 1280);
    assert.strictEqual(tun.queueDepth, DEFAULT_TUN_POLL_QUEUE_DEPTH);
  });

  it('pauses TUN polling when the device socket write buffer fills', function () {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();
    socket._writable = false;

    manager.tun = tun;
    manager.mtu = 1280;
    manager.startTunReadLoop(socket);

    const packet = Buffer.from([0x60, 0, 0, 0, 0, 0, 0, 0]);
    tun.callback(packet);

    assert.strictEqual(tun.paused, true);
    assert.strictEqual(manager.tunReadPausedForBackpressure, true);

    socket._writable = true;
    socket.emit('drain');

    assert.strictEqual(tun.paused, false);
    assert.strictEqual(manager.tunReadPausedForBackpressure, false);
  });
});
