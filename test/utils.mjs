/**
 * Returns true if the current process is running as root.
 * Works cross-platform (returns false if getuid is not available).
 */
export function isRoot() {
  return typeof process.getuid === "function" ? process.getuid() === 0 : false;
}
