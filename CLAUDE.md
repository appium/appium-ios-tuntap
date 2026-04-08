# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Install dependencies
npm install

# Build native addon + TypeScript (required before running tests)
npm run prepare

# Build only the native C++ addon
npm run build:addon

# Build only TypeScript
npm run build

# Lint
npm run lint
npm run lint:fix

# Run all tests (unit + integration; integration requires root)
sudo npm test

# Run a specific test suite (most do not require root)
npm run test:security
npm run test:tunnel-manager
npm run test:packet-stream
npm run test:cdtunnel-protocol
npm run test:buffer-handling
npm run test:ipv6-format

# Run a single test file directly
npx mocha 'test/security.spec.mjs' --exit --timeout 30s

# Unit and integration tests (require root on macOS/Linux)
sudo npm run test:unit
sudo npm run test:integration
```

## Architecture

This is a Node.js native addon package that provides TUN/TAP virtual network device support for Appium iOS tunneling. It has two layers:

### Native Layer (`src/tuntap.cc`)
A C++17 Node-API (NAPI) addon built via `node-gyp`. It exposes a single `TunDevice` class with `open()`, `close()`, `read()`, `write()`, `startPolling()`, `getName()`, and `getFd()`. Platform-specific code is conditional: macOS uses `utun` (kernel control socket via `UTUN_CONTROL_NAME`), Linux uses `/dev/net/tun` with `IFF_TUN`. The `startPolling` method uses a libuv poll handle (`uv_poll_t`) to drive event-based reads from the native thread pool rather than blocking JS.

### TypeScript Layer (`src/`)
- **`TunTap.ts`** — wraps the native addon, adds validation (IPv6, MTU range, buffer size), custom error types (`TunTapError`, `TunTapPermissionError`, `TunTapDeviceError`), and async helpers that shell out to `ifconfig`/`route` (macOS) or `ip` (Linux) via `execFile` with `sudo`.
- **`tunnel.ts`** — implements the CDTunnel protocol used by iOS CoreDevice tunneling. `exchangeCoreTunnelParameters` performs a JSON handshake over a `CDTunnel`-framed TCP socket (8-byte magic + 2-byte length). `TunnelManager` (extends `EventEmitter`) bridges the Socket ↔ TUN device bidirectionally, parses IPv6 packets from the stream, and dispatches `PacketData` (TCP/UDP) to registered consumers or async iterators. `connectToTunnelLockdown` orchestrates handshake → interface setup → forwarding start.
- **`logger.ts`** — thin wrapper around `@appium/support` logger.
- **`index.ts`** — re-exports `TunTap` and everything from `tunnel.ts`.

### Build Output
- `build/Release/tuntap.node` — compiled native addon (loaded at runtime via `createRequire`)
- `lib/` — compiled TypeScript output; `lib/index.js` is the package entry point

### Test Structure
Tests in `test/` are `.mjs` ES module files using Mocha:
- `security.spec.mjs`, `buffer-handling.spec.mjs`, `ipv6-format.spec.mjs`, `packet-stream.spec.mjs`, `cdtunnel-protocol.spec.mjs`, `tunnel-manager.spec.mjs` — pure logic tests, no root required; use `createMockSocket()` from `test/utils.mjs`
- `tuntap-unit.spec.mjs`, `tuntap-integration.spec.mjs` — require root; tests that detect non-root will skip themselves

### Key Constraints
- Only IPv6 is supported (all addresses, routes, and packet parsing are IPv6-only)
- `configure()` and route methods shell out with `sudo` — the caller must ensure sudo access
- Signal handling (`SIGINT`/`SIGTERM`) is intentionally left to the caller; `TunTap` only registers a `process.once('exit')` cleanup handler
- The native `startPolling` is one-shot per device; stopping is done by closing the TUN fd
