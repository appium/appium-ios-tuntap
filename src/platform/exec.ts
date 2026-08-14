import {execFile, type ExecFileOptions} from 'node:child_process';
import {promisify} from 'node:util';

const execFilePromisified = promisify(execFile);

/** Networking commands finish well under a second; this only trips on a wedged one. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** `execFile` with a timeout, so a hung OS command surfaces as an error instead of stalling. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{stdout: string; stderr: string}> {
  return execFilePromisified(file, args, {
    timeout: DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    ...options,
    encoding: 'utf8',
  });
}
