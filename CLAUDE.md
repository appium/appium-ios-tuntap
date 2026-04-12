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

# Tests (unit + integration; scripts invoke sudo for mocha on macOS/Linux)
npm test

# Unit or integration only
npm run test:unit
npm run test:integration

# Ad-hoc: run mocha on a single file (add sudo if the test needs root)
sudo npx mocha 'test/tuntap-unit.spec.mjs' --exit --timeout 2m
```

## Project structure

```
src/
  tuntap.cc              # C++ NAPI addon (built to build/Release/tuntap.node)
  index.ts               # Package entry: TunTap, PacketCallback, errors, tunnel/*
  TunTap.ts              # Wraps native TunDevice; validation; delegates OS networking to platform layer
  tunnel.ts              # CDTunnel protocol, TunnelManager, connectToTunnelLockdown
  logger.ts              # @appium/support logger
  errors.ts              # TunTapError, TunTapPermissionError, TunTapDeviceError
  platform/
    types.ts             # TunTapPlatform interface, TunTapInterfaceStats
    create-platform.ts   # Internal: maps NodeJS.Platform → platform implementation (not public API)
    darwin.ts            # ifconfig, route, netstat (macOS)
    linux.ts             # iproute2 `ip` (Linux)
    unsupported.ts       # Stub that throws for unknown platforms
    exec.ts              # promisify(execFile)
    require-root.ts      # assertEffectiveRoot() — EUID 0 before privileged commands

test/
  tuntap-unit.spec.mjs
  tuntap-integration.spec.mjs
  test-tuntap.mjs
  utils.mjs
  check-linux-prereqs.sh
```

## Architecture

This is a Node.js native addon package that provides TUN/TAP virtual network device support for Appium iOS tunneling. It has two layers:

### Native layer (`src/tuntap.cc`)

A C++17 Node-API (NAPI) addon built via `node-gyp`. It exposes a single `TunDevice` class with `open()`, `close()`, `read()`, `write()`, `startPolling()`, `getName()`, and `getFd()`. Platform-specific code is conditional: macOS uses `utun` (kernel control socket via `UTUN_CONTROL_NAME`), Linux uses `/dev/net/tun` with `IFF_TUN`. The `startPolling` method uses a libuv poll handle (`uv_poll_t`) to drive event-based reads from the native thread pool rather than blocking JS.

### TypeScript layer (`src/`)

- **`errors.ts`** — shared error classes used by `TunTap` and `platform/*`.
- **`TunTap.ts`** — loads the native addon via `createRequire`, validates IPv6/MTU/buffers, and calls a **`TunTapPlatform`** instance chosen by **`new TunTap(name?, platform?)`** where `platform` is a **`NodeJS.Platform`** string (default `process.platform`). No custom platform object is accepted at runtime; new OS support is wired in **`platform/create-platform.ts`**.
- **`platform/*`** — OS-specific **`execFile`** usage for address, MTU, routes, and stats. Built-in Darwin/Linux paths require **effective UID 0** (**`assertEffectiveRoot`**); commands are run **without** embedding `sudo` in argv. **`getStats`** uses read-only tooling where possible without an extra root check.
- **`tunnel.ts`** — CDTunnel handshake (`exchangeCoreTunnelParameters`), **`TunnelManager`** (typed **`TunnelManagerEvents`** / `data` → **`PacketData`**), and **`connectToTunnelLockdown`**.
- **`logger.ts`** — thin wrapper around `@appium/support` logger.
- **`index.ts`** — re-exports **`TunTap`**, **`PacketCallback`**, errors from **`errors.ts`**, and **`export *`** from **`tunnel.ts`**. Does **not** export the platform factory or concrete platform classes.

### Build output

- `build/Release/tuntap.node` — compiled native addon (loaded at runtime via `createRequire`)
- `lib/` — compiled TypeScript output; `lib/index.js` is the package entry point

### Tests

Mocha **`.mjs`** ES modules under **`test/`**. **`tuntap-unit.spec.mjs`** and **`tuntap-integration.spec.mjs`** expect **root** (scripts use `sudo`). Running as non-root may skip or fail depending on the case.

### Key constraints

- Only **IPv6** is supported (addresses, routes, packet parsing).
- **`configure()`**, **`addRoute()`**, and **`removeRoute()`** on built-in platforms require the process to run as **root (EUID 0)**.
- Signal handling (`SIGINT`/`SIGTERM`) is left to the caller; `TunTap` registers **`process.once('exit')`** cleanup only.
- Native **`startPolling`** is one-shot per device; stopping is done by closing the TUN fd.
