import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

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

  write(data) {
    return data?.length ?? 0;
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
    this.paused = false;
  }

  setNoDelay() {}

  setKeepAlive() {}

  write(data) {
    this.emit('written', data);
    return this._writable;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

describe('TunnelManager forwarding', () => {
  it('uses a larger poll buffer and deeper queue when packet tap is off', () => {
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

  it('uses MTU-sized poll buffer and default queue when packet tap is on', () => {
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

  it('pauses TUN polling when the device socket write buffer fills', () => {
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

  it('logs TUN write errors and advances past the frame', () => {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    tun.write = () => {
      throw new Error('write failed');
    };

    manager.tun = tun;
    manager.mtu = 1280;

    const packet = Buffer.alloc(1280);
    packet[0] = 0x60;
    packet.writeUInt16BE(1240, 4);
    manager.buffer = packet;
    manager.processBuffer();

    assert.strictEqual(manager.buffer.length, 0);
  });

  it('resumes device ingress when only an incomplete frame remains after draining', () => {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();

    manager.tun = tun;
    manager.deviceConn = socket;
    manager.mtu = 1280;

    const complete = Buffer.alloc(1280);
    complete[0] = 0x60;
    complete.writeUInt16BE(1240, 4);

    const incompleteTail = Buffer.alloc(20);
    incompleteTail[0] = 0x60;

    manager.buffer = Buffer.concat([complete, incompleteTail]);
    manager.deviceIngressPausedForTun = true;
    socket.paused = true;

    manager.processBuffer();

    assert.strictEqual(socket.paused, false);
    assert.strictEqual(manager.deviceIngressPausedForTun, false);
    assert.strictEqual(manager.buffer.length, 20);
  });
});
