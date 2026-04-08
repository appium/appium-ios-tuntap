import { EventEmitter } from 'node:events';

/**
 * Returns true if the current process is running as root.
 * Works cross-platform (returns false if getuid is not available).
 */
export function isRoot() {
  return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
}

/**
 * Creates a minimal mock socket (EventEmitter with write/destroy/end).
 * Used by tests that exercise TunnelManager and CDTunnel protocol logic
 * without requiring a real network connection or root privileges.
 */
export function createMockSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writtenData = [];
  socket.unshiftedData = [];
  socket.write = (data) => {
    socket.writtenData.push(data);
    return true;
  };
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  socket.end = () => {
    socket.destroyed = true;
    socket.emit('end');
  };
  socket.unshift = (data) => {
    socket.unshiftedData.push(data);
  };
  return socket;
}
