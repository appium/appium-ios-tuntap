# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
# Install dependencies
npm install

# TypeScript compile (runs on prepare after install; required before tests if lib/ is stale)
npm run prepare

# Native addon: install runs node-gyp-build (uses prebuilds/ when present, else compiles)
npm install

# Build only the native C++ addon (from source)
npm run build:addon

# Produce N-API prebuilds under prebuilds/ (release CI uses this per OS/arch matrix)
npm run build:prebuilds

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
  tuntap.cc              # C++ Node-API surface (TunDevice class + module exports)
  native/
    file_descriptor.h    # RAII file descriptor abstraction used by native backends
    file_descriptor.cc   # FileDescriptor implementation
    tun_backend.h        # TunPlatformBackend interface + OpenResult + shared declarations
    tun_backend_common.cc# Backend factory + non-blocking fd helper
    tun_backend_darwin.cc# macOS utun backend implementation
    tun_backend_linux.cc # Linux /dev/net/tun backend implementation
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

### Native layer (`src/tuntap.cc`, `src/native/*`)

A C++17 Node-API (NAPI) addon built via `node-gyp`. `src/tuntap.cc` is intentionally kept as the N-API interface/glue: it exposes `TunDevice` (`open()`, `close()`, `read()`, `write()`, `startPolling()`, `getName()`, `getFd()`), validates JS arguments, manages libuv polling (`uv_poll_t`), and bridges callbacks via `Napi::ThreadSafeFunction`.

Native implementation details are split into `src/native/*`:
- `TunPlatformBackend` interface in `tun_backend.h`
- platform-specific backends in `tun_backend_darwin.cc` (utun) and `tun_backend_linux.cc` (`/dev/net/tun`)
- shared utilities/factory in `tun_backend_common.cc`
- `FileDescriptor` RAII abstraction in `file_descriptor.*`

### TypeScript layer (`src/`)

- **`errors.ts`** — shared error classes used by `TunTap` and `platform/*`.
- **`TunTap.ts`** — loads the native addon via **`node-gyp-build`** (prebuilds or `build/Release`), validates IPv6/MTU/buffers, and calls a **`TunTapPlatform`** instance chosen by **`new TunTap(name?, platform?)`** where `platform` is a **`NodeJS.Platform`** string (default `process.platform`). No custom platform object is accepted at runtime; new OS support is wired in **`platform/create-platform.ts`**.
- **`platform/*`** — OS-specific **`execFile`** usage for address, MTU, routes, and stats. Built-in Darwin/Linux paths require **effective UID 0** (**`assertEffectiveRoot`**); commands are run **without** embedding `sudo` in argv. **`getStats`** uses read-only tooling where possible without an extra root check.
- **`tunnel.ts`** — CDTunnel handshake (`exchangeCoreTunnelParameters`), **`TunnelManager`** (typed **`TunnelManagerEvents`** / `data` → **`PacketData`**), and **`connectToTunnelLockdown`**.
- **`logger.ts`** — thin wrapper around `@appium/support` logger.
- **`index.ts`** — re-exports **`TunTap`**, **`PacketCallback`**, errors from **`errors.ts`**, and **`export *`** from **`tunnel.ts`**. Does **not** export the platform factory or concrete platform classes.

### Build output

- `prebuilds/<platform>-<arch>/*.node` — N-API binaries shipped in the npm package (built in release CI)
- `build/Release/tuntap.node` — local compile fallback (from `npm run build:addon` or `node-gyp-build` at install)
- `lib/` — compiled TypeScript output; `lib/index.js` is the package entry point

### Tests

Mocha **`.mjs`** ES modules under **`test/`**. **`tuntap-unit.spec.mjs`** and **`tuntap-integration.spec.mjs`** expect **root** (scripts use `sudo`). Running as non-root may skip or fail depending on the case.

### Key constraints

- Only **IPv6** is supported (addresses, routes, packet parsing).
- **`configure()`**, **`addRoute()`**, and **`removeRoute()`** on built-in platforms require the process to run as **root (EUID 0)**.
- Signal handling (`SIGINT`/`SIGTERM`) is left to the caller; `TunTap` registers **`process.once('exit')`** cleanup only.
- Native **`startPolling`** is one-shot per device; stopping is done by closing the TUN fd.
