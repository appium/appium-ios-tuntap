#!/usr/bin/env node

import { TunTap } from '../lib/index.js';
import { log } from '../lib/logger.js';

// Enable debug logging
process.argv.push('--debug');

async function main() {
    console.log('TunTap Bridge Test Utility');
    console.log('=========================');
    console.log('Platform:', process.platform);
    console.log('Node.js version:', process.version);
    console.log('User:', process.env.USER);
    console.log('Running as root:', process.getuid && process.getuid() === 0 ? 'Yes' : 'No');
    console.log('');

    try {
        // Step 1: Create and open TUN device
        console.log('Step 1: Creating TUN device...');
        const tun = new TunTap();
        
        const success = tun.open();
        if (!success) {
            throw new Error('Failed to open TUN device');
        }
        
        console.log(`✓ Successfully opened TUN device: ${tun.name}`);
        console.log(`  Device file descriptor: ${tun.fd}`);
        
        // Step 2: Configure the interface
        console.log('\nStep 2: Configuring interface...');
        try {
            await tun.configure('fd00::1', 1500);
            console.log('✓ Successfully configured interface');
        } catch (err) {
            console.error('✗ Failed to configure interface:', err.message);
            
            if (process.platform === 'linux') {
                // Check for common Linux issues
                try {
                    const { exec } = await import('child_process');
                    const util = await import('util');
                    const execPromise = util.promisify(exec);
                    
                    // Check if TUN module is loaded
                    try {
                        const { stdout } = await execPromise('lsmod | grep tun');
                        console.log('  TUN kernel module is loaded:', stdout.trim());
                    } catch (e) {
                        console.log('  TUN kernel module is NOT loaded. Try: sudo modprobe tun');
                    }
                    
                    // Check if iproute2 is installed
                    try {
                        const { stdout } = await execPromise('which ip');
                        console.log('  ip command is available at:', stdout.trim());
                    } catch (e) {
                        console.log('  ip command is NOT available. Try: sudo apt install iproute2');
                    }
                    
                    // Check permissions on /dev/net/tun
                    try {
                        const { stdout } = await execPromise('ls -la /dev/net/tun');
                        console.log('  /dev/net/tun permissions:', stdout.trim());
                    } catch (e) {
                        console.log('  Could not check /dev/net/tun permissions:', e.message);
                    }
                } catch (diagErr) {
                    console.error('  Error running diagnostics:', diagErr);
                }
            }
            
            throw err;
        }
        
        // Step 3: Add a route
        console.log('\nStep 3: Adding route...');
        try {
            await tun.addRoute('fd00::/64');
            console.log('✓ Successfully added route');
        } catch (err) {
            console.error('✗ Failed to add route:', err.message);
            throw err;
        }
        
        // Step 4: Test read/write
        console.log('\nStep 4: Testing read/write (will timeout after 5 seconds)...');
        console.log('  Waiting for data on the TUN interface...');
        
        // Set up a timeout to end the test after 5 seconds
        const timeout = setTimeout(() => {
            console.log('  No data received within timeout period (this is normal if no traffic is being sent)');
            console.log('\nTest completed successfully!');
            console.log('If you encountered any errors, please check the README.md troubleshooting section.');
            
            // Clean up
            tun.close();
            process.exit(0);
        }, 5000);
        
        // Try to read data from the TUN device
        const readInterval = setInterval(() => {
            try {
                const data = tun.read(4096);
                if (data && data.length > 0) {
                    console.log(`  Received ${data.length} bytes from TUN interface`);
                    
                    // Echo the data back
                    const bytesWritten = tun.write(data);
                    console.log(`  Wrote ${bytesWritten} bytes back to TUN interface`);
                    
                    // Clear the timeout and interval
                    clearTimeout(timeout);
                    clearInterval(readInterval);
                    
                    console.log('\nTest completed successfully!');
                    console.log('If you want to generate traffic on this interface, try:');
                    if (process.platform === 'darwin') {
                        console.log(`  ping6 -c 3 fd00::1%${tun.name}`);
                    } else {
                        console.log(`  ping6 -c 3 fd00::1 -I ${tun.name}`);
                    }
                    
                    // Keep the test running for a bit longer
                    setTimeout(() => {
                        tun.close();
                        process.exit(0);
                    }, 10000);
                }
            } catch (err) {
                console.error('  Error reading from TUN interface:', err.message);
                clearTimeout(timeout);
                clearInterval(readInterval);
                tun.close();
                process.exit(1);
            }
        }, 100);
        
    } catch (err) {
        console.error('\nTest failed:', err.message);
        console.log('Please check the README.md troubleshooting section for solutions.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
