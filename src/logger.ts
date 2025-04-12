// logger.ts
// Check if the '--debug' flag is present among the command line arguments.
const debugEnabled = process.argv.includes('--debug');

// A simple log function that prints to console only if debug is enabled.
export function log(...args: any[]): void {
    if (debugEnabled) {
        console.log(...args);
    }
}
