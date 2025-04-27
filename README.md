# TunTap Bridge

A native TUN/TAP interface module for Node.js that works on both macOS and Linux.

## Description

This module provides a Node.js interface to TUN/TAP virtual network devices, allowing you to create and manage network tunnels from JavaScript/TypeScript. It's useful for VPNs, network tunneling, and other network-related applications.

## Installation

```bash
npm install tuntap-bridge
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

```javascript
import { TunTap } from 'tuntap-bridge';

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
  
  // Close the device when done
  tun.close();
}
```

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

## License

MIT
