/**
 * Append socket/TUN chunks without repeated Buffer.concat growth copies.
 */
export function appendBuffer(existing: Buffer, chunk: Buffer): Buffer {
  if (chunk.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return Buffer.from(chunk);
  }
  const combined = Buffer.allocUnsafe(existing.length + chunk.length);
  existing.copy(combined, 0);
  chunk.copy(combined, existing.length);
  return combined;
}
