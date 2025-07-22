# TunTap Bridge

A native TUN/TAP interface module for Node.js that works on both macOS and Linux, with enhanced error handling, signal management, and thread safety.

## Description

This module provides a Node.js interface to TUN/TAP virtual network devices, allowing you to create and manage network tunnels from JavaScript/TypeScript. It's useful for VPNs, network tunneling, and other network-related applications.

## Features

- **Cross-platform**: Works on macOS (utun) and Linux (TUN/TAP)
- **TypeScript support**: Full TypeScript definitions included
- **Signal handling**: Graceful shutdown on SIGINT/SIGTERM
- **Thread safety**: Safe to use from multiple Node.js worker threads
- **Resource management**: Automatic cleanup of file descriptors and network interfaces
- **Enhanced error handling**: Custom error types for better debugging
- **Input validation**: Validates IPv6 addresses, MTU ranges, and buffer sizes
- **Performance optimized**: Built with C++17 and compiler optimizations
- **Network statistics**: Get interface statistics (RX/TX bytes, packets, errors)

## Installation

```bash
npm install appium-ios-tuntap
```

## Prerequisites

### macOS

On macOS, the module uses the built-in utun interfaces. No additional setup is required, but you'll need administrator privileges to create and configure the interfaces.

### Linux

On Linux, the module requires:

1. **TUN/TAP Kernel Module**: The TUN/TAP kernel module must be loaded.

   ```bash
   # Check if the module is loaded
   lsmod | grep tun

   # If not loaded, load it
   sudo modprobe tun

   # To load it automatically at boot
   echo "tun" | sudo tee -a /etc/modules
   ```

2. **Permissions**: The user running the application needs access to `/dev/net/tun`.

   ```bash
   # Option 1: Run your application with sudo
   sudo node your-app.js

   # Option 2: Add your user to the 'tun' group (if it exists)
   sudo usermod -a -G tun your-username

   # Option 3: Create a udev rule to set permissions
   echo 'KERNEL=="tun", GROUP="your-username", MODE="0660"' | sudo tee /etc/udev/rules.d/99-tuntap.rules
   sudo udevadm control --reload-rules
   sudo udevadm trigger
   ```

3. **iproute2 Package**: The `ip` command is required for configuring interfaces.

   ```bash
   # Debian/Ubuntu
   sudo apt install iproute2

   # CentOS/RHEL
   sudo yum install iproute

   # Arch Linux
   sudo pacman -S iproute2
   ```

4. **Development Headers**: If you're building from source, you'll need the Linux kernel headers.

   ```bash
   # Debian/Ubuntu
   sudo apt install linux-headers-$(uname -r)

   # CentOS/RHEL
   sudo yum install kernel-devel

   # Arch Linux
   sudo pacman -S linux-headers
   ```

## Usage

### Basic Usage

```javascript
import { TunTap } from 'appium-ios-tuntap';

// Create a TUN device
const tun = new TunTap();

// Open the device
if (tun.open()) {
  console.log(`Opened TUN device: ${tun.name}`);

  // Configure the device with an IPv6 address and MTU
  await tun.configure('fd00::1', 1500);

  // Add a route
  await tun.addRoute('fd00::/64');

  // Read from the device
  const data = tun.read(4096);
  if (data.length > 0) {
    console.log(`Read ${data.length} bytes`);
  }

  // Write to the device
  const buffer = Buffer.from([/* your packet data */]);
  const bytesWritten = tun.write(buffer);
  console.log(`Wrote ${bytesWritten} bytes`);

  // Get interface statistics
  const stats = await tun.getStats();
  console.log('RX bytes:', stats.rxBytes);
  console.log('TX bytes:', stats.txBytes);

  // Close the device when done
  tun.close();
}
```

### Error Handling

```javascript
import { TunTap, TunTapError, TunTapPermissionError, TunTapDeviceError } from 'appium-ios-tuntap';

try {
  const tun = new TunTap();
  tun.open();
  await tun.configure('fe80::1', 1500);
  // ... use the device ...
  tun.close();
} catch (err) {
  if (err instanceof TunTapPermissionError) {
    console.error('Permission denied. Please run with sudo.');
  } else if (err instanceof TunTapDeviceError) {
    console.error('Device error:', err.message);
  } else if (err instanceof TunTapError) {
    console.error('TUN/TAP error:', err.message);
  } else {
    console.error('Unexpected error:', err);
  }
}
```

### Tunnel Manager

```javascript
import { connectToTunnelLockdown } from 'appium-ios-tuntap';
import { Socket } from 'net';

// Create a socket connection to your tunnel endpoint
const socket = new Socket();
socket.connect(port, host, async () => {
  try {
    // Establish tunnel connection
    const tunnel = await connectToTunnelLockdown(socket);

    console.log('Tunnel established:', tunnel.Address);

    // Add packet consumer
    tunnel.addPacketConsumer({
      onPacket: (packet) => {
        console.log(`${packet.protocol} packet: ${packet.src}:${packet.sourcePort} → ${packet.dst}:${packet.destPort}`);
      }
    });

    // Or use async iteration
    for await (const packet of tunnel.getPacketStream()) {
      console.log('Received packet:', packet);
    }

    // Close tunnel when done
    await tunnel.closer();
  } catch (err) {
    console.error('Tunnel error:', err);
  }
});
```

## API Reference

### TunTap Class

#### Constructor
- `new TunTap(name?: string)` - Create a new TUN/TAP device instance

#### Methods
- `open(): boolean` - Open the TUN device
- `close(): boolean` - Close the TUN device
- `read(maxSize?: number): Buffer` - Read data from the device (default: 4096 bytes)
- `write(data: Buffer): number` - Write data to the device
- `configure(address: string, mtu?: number): Promise<void>` - Configure IPv6 address and MTU
- `addRoute(destination: string): Promise<void>` - Add a route to the device
- `removeRoute(destination: string): Promise<void>` - Remove a route from the device
- `getStats(): Promise<Stats>` - Get interface statistics

#### Properties
- `name: string` - The device name (e.g., 'utun0', 'tun0')
- `fd: number` - The file descriptor of the device

### Error Types

- `TunTapError` - Base error class for all TUN/TAP errors
- `TunTapPermissionError` - Thrown when there are permission issues
- `TunTapDeviceError` - Thrown when the device is not available or cannot be opened

### Signal Handling

The module automatically handles SIGINT and SIGTERM signals for graceful shutdown. All open devices will be closed and network interfaces cleaned up when the process exits.

## Troubleshooting

### Linux Issues

1. **"TUN/TAP device not available"**: The TUN/TAP kernel module is not loaded.
   - Solution: `sudo modprobe tun`

2. **"Permission denied" when opening /dev/net/tun**: The user doesn't have sufficient permissions.
   - Solution: Run with sudo or add your user to the 'tun' group.

3. **"Permission denied" when configuring the interface**: The user doesn't have sudo privileges.
   - Solution: Run the application with sudo or configure sudo to allow the specific commands without a password.

4. **"Command not found" when configuring the interface**: The `ip` command is not available.
   - Solution: Install the iproute2 package.

### macOS Issues

1. **"Failed to create control socket"**: The application doesn't have sufficient permissions.
   - Solution: Run with sudo.

2. **"Could not find an available utun device"**: All utun devices are in use.
   - Solution: Close other applications that might be using utun devices.

## Debug Mode

Enable debug logging by running your application with the `--debug` flag:

```bash
node your-app.js --debug
```

## License

Apache-2.0
