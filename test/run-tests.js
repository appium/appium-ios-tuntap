import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runTestFile = (file) => {
    return new Promise((resolve, reject) => {
        const mochaPath = path.resolve(__dirname, '..', 'node_modules', '.bin', 'mocha');
        const testProcess = spawn('sudo', [mochaPath, path.resolve(__dirname, file)], {
            stdio: 'inherit',
            shell: true
        });

        testProcess.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Test file ${file} failed with exit code ${code}`));
            }
        });

        testProcess.on('error', (err) => {
            reject(err);
        });
    });
};

async function main() {
    try {
        console.log('Running integration tests...');
        await runTestFile('tuntap-integration.spec.js');
        
        console.log('\nRunning unit tests...');
        await runTestFile('tuntap-unit.spec.js');
        
        console.log('\nAll tests passed!');
        process.exit(0);
    } catch (error) {
        console.error('\nTests failed:', error.message);
        process.exit(1);
    }
}

main();
