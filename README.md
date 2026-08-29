# TunTap Bridge

A native TUN/TAP interface module for Node.js that works on macOS, Linux, and Windows, with enhanced error handling and thread safety.

## Description

This module provides a Node.js interface to TUN/TAP virtual network devices, allowing you to create and manage network tunnels from JavaScript/TypeScript. It's useful for VPNs, network tunneling, and other network-related applications.

## Features

- **Cross-platform**: Works on macOS (utun), Linux (TUN/TAP), and Windows (WinTun)
- **TypeScript support**: Full TypeScript definitions included
- **Thread safety**: Safe to use from multiple Node.js worker threads
- **Resource management**: Devices are closed on normal process exit; the kernel releases the fd otherwise
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

### Windows

On Windows the module uses [WinTun](https://www.wintun.net/) (the same userspace TUN driver shipped with WireGuard). Requirements:

1. **Apple Mobile Device drivers**: required for USB communication with iOS devices. Install them through Apple's standalone iTunes package for Windows (the non-Microsoft Store installer includes the Apple Mobile Device Support drivers).
2. **`wintun.dll`**: ships with the package. The official signed binaries for `amd64`, `arm64`, `x86`, and `arm` are bundled under `vendor/wintun/bin/<arch>/wintun.dll`; the addon discovers the right one automatically based on its own compile-time architecture. No download or copy step is required.
3. **Administrator privileges**: required to create the kernel adapter and configure addresses/routes via `netsh`. Launch your shell with **Run as administrator**.
4. **OpenSSL for source builds**: release prebuilds statically link OpenSSL. If compiling from source on Windows, install static OpenSSL (for example `vcpkg install openssl:x64-windows-static`) and set `OPENSSL_ROOT_DIR` to the installed triplet directory.
5. **Build toolchain (only if compiling from source)**: Visual Studio Build Tools 2022 with the C++ workload, the Windows 10 SDK, and Python 3.x on `PATH`.

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

// Plain TCP socket to CoreDeviceProxy + lockdown pair-record PEM (do not use Node TLS first)
const { socket, cert, key } = await startCoreDeviceProxyTcp(...);

const tunnel = await connectToTunnelLockdown(socket, { cert, key });
console.log('Tunnel established:', tunnel.Address);
await tunnel.closer();
```

`connectToTunnelLockdown()` and `connectToTunnelPsk()` are supported on macOS, Linux, and Windows. On Windows, run from an elevated shell so WinTun adapter creation and `netsh` route configuration can succeed.

## API Reference

### TunTap Class

#### Constructor
- `new TunTap(name?: string, platform?: NodeJS.Platform)` - Create a new TUN/TAP device instance. `platform`
  selects the OS backend used for addressing and routing, and defaults to `process.platform`.

#### Methods
- `open(): boolean` - Open the TUN device
- `close(): boolean` - Close the TUN device
- `read(maxSize?: number): Buffer` - Read data from the device (default: 4096 bytes). Non-blocking: returns an empty buffer when no packet is queued. Unsupported while a `TunnelForwarder` is active on the device — concurrent reads race with the forwarder (lost packets or crashes).
- `write(data: Buffer): number` - Write data to the device. Unsupported while a `TunnelForwarder` is active — concurrent writes race with the forwarder.
- `configure(address: string, mtu?: number): Promise<void>` - Configure IPv6 address and MTU
- `addRoute(destination: string): Promise<void>` - Add a route to the device
- `removeRoute(destination: string): Promise<void>` - Remove a route from the device
- `getStats(): Promise<Stats>` - Get interface statistics (`rxBytes`, `txBytes`, `rxPackets`, `txPackets`, `rxErrors`, `txErrors`)

#### Properties
- `name: string` - The device name (e.g., 'utun0', 'tun0')
- `fd: number` - The native file descriptor on POSIX (macOS/Linux). Returns `-1` on Windows; Wintun does not expose a numeric file descriptor.
- `isOpen: boolean` - `open()` has succeeded and `close()` has not run
- `isClosed: boolean` - `close()` has been called; the device cannot be reopened

### Error Types

- `TunTapError` - Base error class for all TUN/TAP errors
- `TunTapPermissionError` - Thrown when there are permission issues
- `TunTapDeviceError` - Thrown when the device is not available or cannot be opened

### Signal Handling

The module does **not** install `SIGINT`/`SIGTERM` handlers — a library should not take over signals from the
application that embeds it. It registers a `process.once('exit')` hook that closes any open device on a normal
exit.

`exit` handlers do not run when a process is terminated by a signal, so on Ctrl+C the device is not closed by
this module; the kernel releases the file descriptor and tears down the interface when the process dies. If you
need cleanup to run on a signal, install your own handler and call `close()`:

```javascript
process.once('SIGINT', () => {
  tun.close();
  process.exit(130);
});
```

## Environment Variables

### APPIUM_TUNTAP_MTU_REQUEST_SIZE

MTU to request from the device in the CDTunnel handshake. Defaults to `1280` (the IPv6 minimum). Accepts integers in `1280`–`65000`; out-of-range values are clamped and invalid values fall back to the default with a warning. The device decides the granted value, which is what actually gets applied — the tunnel log shows `requested X, granted Y`.

Note: a device may grant a value it cannot reliably carry (observed: a grant of 16000 where packets above ~8 KB were silently dropped, breaking AFC). Validate any non-default value with the AFC tests below before adopting it.

## Verifying AFC data-path changes

Any change touching the forwarding path (native forwarder, backends, tunnel MTU, TLS) must be verified against a real device with the AFC tests in [appium-ios-remotexpc](https://github.com/appium/appium-ios-remotexpc). With a live tunnel up (`npm run tunnel-creation`):

```sh
# Throughput: pushes a 10 MiB file over AFC, reports MiB/s
npm run test:afc-push-perf

# Stability: 20 rounds of 10 MiB push + pull + sha256 verify over one AFC session
AFC_STABILITY_ITERATIONS=20 npm run test:afc-tunnel-stability
```

Both must pass, and push throughput should be flat or better versus a run on the unchanged build. Compare only runs on the same link: USB and Wi-Fi tunnels differ by an order of magnitude (check the `Connection:` type logged by tunnel-creation).

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

Set `APPIUM_TUNTAP_DEBUG=1` to enable tunnel debug logging. The TypeScript layer logs through
`@appium/support`; the native forwarder writes `[fwd] #N event key=value` lines to stderr.

```bash
APPIUM_TUNTAP_DEBUG=1 node your-app.js
```

## Testing

Most tests for this module require **root privileges** (sudo) to create and manage TUN/TAP devices.

- If you run the tests without root, privileged tests will be automatically skipped.
- Some tests may interact with system networking; use caution on production systems.
- The test suite is designed to clean up after itself, but always verify no stray TUN/TAP devices remain after running.

### Running the Tests

From the project root, run:

```sh
sudo npm run test:unit
```

On Windows, use an elevated PowerShell:

```powershell
npm run build:addon
npm run test:unit
```

Or, to run all tests:

```sh
sudo npm test
```

If you are **not** running as root, you will see a message that tests are skipped.

Windows tunnel-forwarder end-to-end testing requires a real device tunnel source. From an elevated PowerShell, build the addon, run the unit tests, then establish a CoreDevice/RemoteXPC tunnel and verify the forwarded tunnel remains stable under AFC or similar traffic.

### Manual Testing for Device Cleanup

1. Build the project, then run the compiled CLI utility:
   ```sh
   npm run build
   sudo node lib/test/test-tuntap.js
   ```
2. While it is running, press `Ctrl+C`.
3. Confirm the process exits and the interface is gone (`ifconfig` on macOS, `ip link` on Linux).

The interface disappears because the kernel closes the file descriptor when the process dies, not because
the module handled the signal — see [Signal Handling](#signal-handling).

## License

Apache-2.0

### Third-party software

This package redistributes the official signed **WinTun** DLLs (version 0.14.1) from [wintun.net](https://www.wintun.net/) under the bundled-binary license shipped by the WinTun project. The unmodified binaries and the upstream license live under [vendor/wintun/](vendor/wintun/):

- `vendor/wintun/bin/{amd64,arm64,x86,arm}/wintun.dll`
- `vendor/wintun/LICENSE.txt` &mdash; the upstream WinTun license; required when redistributing the DLL

Maintainers can refresh the bundled binaries with `npm run refresh:wintun` after bumping `WINTUN_VERSION` in [scripts/fetch-wintun.mjs](scripts/fetch-wintun.mjs).
