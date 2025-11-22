import { execSync } from 'child_process';

/**
 * Returns true if the current process is running as root/administrator.
 * Works cross-platform:
 * - Unix/Linux/macOS: checks if UID is 0
 * - Windows: checks for admin privileges
 */
export function isRoot() {
  // Unix-like systems
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0;
  }

  // Windows - check for admin privileges
  if (process.platform === 'win32') {
    try {
      // On Windows, try to execute a command that requires admin privileges
      // 'net session' command requires administrator rights
      execSync('net session 2>&1', { encoding: 'utf8', stdio: 'pipe' });
      return true; // If it succeeds, we have admin rights
    } catch {
      // If command fails, not running as admin
      return false;
    }
  }

  return false;
}
