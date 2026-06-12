import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {TUN_POLL_TSFN_QUEUE_DEPTH} from '../../../lib/tunnel/constants.js';
import {TunnelManager} from '../../../lib/tunnel/manager.js';
import {TunToDevicePump} from '../../../lib/tunnel/tun-to-device-pump.js';
import {DeviceToTunPump} from '../../../lib/tunnel/device-to-tun-pump.js';

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
    this._writable = true;
    this.writableLength = 0;
    this.paused = false;
  }

  setNoDelay() {}

  setKeepAlive() {}

  write(data) {
    this.emit('written', data);
    if (!this._writable) {
      this.writableLength += data.length;
    }
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

describe('TunToDevicePump', {timeout: 5000}, () => {
  it('reads one MTU frame at a time with sequential queue depth', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    const written = [];
    socket.write = (data) => {
      written.push(Buffer.from(data));
      return true;
    };

    const pump = new TunToDevicePump(tun, 1280);
    pump.start(socket);

    assert.strictEqual(tun.pollBuffer, 1280);
    assert.strictEqual(tun.queueDepth, TUN_POLL_TSFN_QUEUE_DEPTH);

    tun.resumePolling();
    tun.callback(Buffer.from([0x60, 0, 0, 1]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(written.length, 1);

    await pump.stop();
  });

  it('waits for drain before reading the next packet', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    const written = [];
    socket.write = (data) => {
      written.push(Buffer.from(data));
      return socket._writable;
    };
    socket._writable = false;

    const pump = new TunToDevicePump(tun, 1280);
    pump.start(socket);

    tun.resumePolling();
    tun.callback(Buffer.from([0x60, 0, 0, 1]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(written.length, 1);
    assert.strictEqual(tun.paused, false);

    tun.callback(Buffer.from([0x60, 0, 0, 2]));
    socket._writable = true;
    socket.emit('drain');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(written.length, 2);
    await pump.stop();
  });

  it('notifies tun writable when waiting for TLS drain', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    let notifyCount = 0;
    socket.write = (data) => {
      socket.emit('written', data);
      return socket._writable;
    };
    socket._writable = false;

    const pump = new TunToDevicePump(tun, 1280, undefined, () => {
      notifyCount += 1;
    });
    pump.start(socket);

    tun.resumePolling();
    tun.callback(Buffer.from([0x60, 0, 0, 1]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(notifyCount >= 1, 'expected notify before/during drain wait');

    await pump.stop();
  });

  it('buffers burst utun packets instead of dropping them', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    const written = [];
    socket.write = (data) => {
      written.push(Buffer.from(data));
      return true;
    };

    const pump = new TunToDevicePump(tun, 1280);
    pump.start(socket);

    tun.resumePolling();
    tun.callback(Buffer.from([0x60, 0, 0, 1]));
    tun.callback(Buffer.from([0x60, 0, 0, 2]));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(written.length, 2);

    await pump.stop();
  });
});

describe('DeviceToTunPump', {timeout: 5000}, () => {
  it('reads one IPv6 frame at a time and yields between frames', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    const written = [];
    tun.write = (data) => {
      written.push(Buffer.from(data));
      return data.length;
    };

    const pump = new DeviceToTunPump();
    pump.start(socket, tun);

    const packet = Buffer.alloc(1280);
    packet[0] = 0x60;
    packet.writeUInt16BE(1240, 4);
    socket.emit('data', packet);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].length, 1280);

    await pump.stop();
  });

  it('does not pause device ingress when utun write blocks', async () => {
    const tun = new MockTunTap();
    const socket = new MockSocket();
    let blocked = true;
    tun.write = () => (blocked ? 0 : 1280);

    const pump = new DeviceToTunPump();
    pump.start(socket, tun);

    const packet = Buffer.alloc(1280);
    packet[0] = 0x60;
    packet.writeUInt16BE(1240, 4);
    socket.emit('data', packet);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(socket.paused, false);

    blocked = false;
    pump.notifyTunWritable();
    await new Promise((resolve) => setImmediate(resolve));

    await pump.stop();
  });
});

describe('TunnelManager forwarding', {timeout: 5000}, () => {
  it('starts sequential TUN→device pump when packet tap is off', () => {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();

    manager.tun = tun;
    manager.mtu = 1280;
    manager.startTunToDevicePump(socket);

    assert.strictEqual(tun.pollBuffer, 1280);
    assert.strictEqual(tun.queueDepth, TUN_POLL_TSFN_QUEUE_DEPTH);
  });

  it('pauses device ingress when TUN write blocks and resumes after forward progress', async () => {
    const manager = new TunnelManager();
    const tun = new MockTunTap();
    const socket = new MockSocket();
    let blockedOnce = true;
    tun.write = () => {
      if (blockedOnce) {
        blockedOnce = false;
        return 0;
      }
      return 1280;
    };

    manager.tun = tun;
    manager.deviceConn = socket;
    manager.mtu = 1280;

    const packet = Buffer.alloc(1280);
    packet[0] = 0x60;
    packet.writeUInt16BE(1240, 4);
    manager.buffer = packet;

    manager.processBuffer();

    assert.strictEqual(socket.paused, true);
    assert.strictEqual(manager.deviceIngressPaused, true);
    assert.strictEqual(manager.buffer.length, 1280);

    manager.startTunToDevicePump(socket);
    tun.resumePolling();
    tun.callback(Buffer.from([0x60, 0, 0, 0, 0, 0, 0, 0]));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(manager.deviceIngressPaused, false);
    assert.strictEqual(manager.buffer.length, 0);

    await manager.tunToDevicePump?.stop();
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
    manager.deviceIngressPaused = true;
    socket.paused = true;

    manager.processBuffer();

    assert.strictEqual(socket.paused, false);
    assert.strictEqual(manager.deviceIngressPaused, false);
    assert.strictEqual(manager.buffer.length, 20);
  });
});
