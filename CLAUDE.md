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

# Lint (TypeScript/JS via oxlint)
npm run lint
npm run lint:fix

# Format/lint C++ (clang-format/clang-tidy; kept separate from `npm run
# format`/`format:check`/`lint` since those tools aren't installed by `npm
# install`. In CI, clang-format runs only on the ubuntu-latest job — its file
# glob covers every platform's sources — while clang-tidy runs on the ubuntu,
# macos, and windows jobs). lint:cpp regenerates build/Release/compile_commands.json
# via node-gyp first, so it only covers sources compiled for the host OS.
npm run format:cpp
npm run format:cpp:check
npm run lint:cpp

# Tests (unit + integration; privileged cases need sudo on macOS/Linux)
npm test

# Unit or integration only
npm run test:unit
npm run test:integration

# Ad-hoc: run node:test on a single file (add sudo if the test needs root)
# Test sources import from src/ (type-checked alongside it) and only run compiled from lib/ after `npm run build`
sudo node --test --test-force-exit --test-timeout=120000 lib/test/unit/tuntap-unit.spec.js

# Windows elevated PowerShell (Administrator) for privileged native tests
npm run build:addon; npm run test:unit
```

## Project structure

```
src/
  tuntap.cc              # C++ Node-API surface (TunDevice class + module exports)
  native/
    file_descriptor.*    # RAII POSIX file descriptor wrapper
    handle.*             # RAII Win32 HANDLE wrapper (mirrors FileDescriptor)
    tun_backend.h        # TunPlatformBackend interface + shared declarations
    posix_tun_backend.h  # Shared POSIX base (fd, interface name, poll loop)
    posix_uv_poll_loop.* # uv_poll receive loop used by the POSIX backends
    tun_backend_darwin.cc# macOS utun backend + CreatePlatformBackend()
    tun_backend_linux.cc # Linux /dev/net/tun backend + CreatePlatformBackend()
    tun_backend_windows.cc# WinTun backend + CreatePlatformBackend()
    wintun_loader.*      # Resolves wintun.dll entry points at runtime
    tunnel_forwarder.*   # TLS <-> TUN forwarding loops + N-API TunnelForwarder
    tunnel_ssl.*         # OpenSSL client (lockdown cert or TLS-PSK)
    ipv6_frame.h         # IPv6 frame length/reassembly helpers
    debug_log.*          # APPIUM_TUNTAP_DEBUG `[fwd]` logging to stderr
    win_delay_load_failure_hook.cc # Names the failing DLL/symbol on Windows delay-load errors
  index.ts               # Package entry: TunTap, PacketCallback, errors, tunnel/*
  TunTap.ts              # Wraps native TunDevice; validation; delegates OS networking to platform layer
  pkg-root.ts            # Memoized package root for node-gyp-build
  tunnel/
    manager.ts           # TunnelManager, connectToTunnelLockdown, connectToTunnelPsk
    forwarder.ts         # TunnelForwarder TS wrapper (+ Windows loopback bridge)
    constants.ts         # CD_TUNNEL_MTU, IPv6 header constants
    debug-log.ts         # APPIUM_TUNTAP_DEBUG + tunDebug
    types.ts             # TunnelConnection, TunnelInfo
  logger.ts              # @appium/support logger
  errors.ts              # TunTapError, TunTapPermissionError, TunTapDeviceError
  platform/
    types.ts             # TunTapPlatform interface, TunTapInterfaceStats
    create-platform.ts   # Internal: maps NodeJS.Platform → platform implementation (not public API)
    darwin.ts            # ifconfig, route, netstat (macOS)
    linux.ts             # iproute2 `ip` (Linux)
    windows.ts           # netsh + PowerShell Get-NetAdapterStatistics
    unsupported.ts       # Stub that throws for unknown platforms
    exec.ts              # execFile wrapper with a 30s timeout
    require-root.ts      # assertEffectiveRoot() — EUID 0 before privileged commands
    require-admin.ts     # assertAdminOnWindows() — Administrator before privileged commands

scripts/
  fetch-wintun.mjs       # Maintainer-only: refresh vendor/wintun binaries
  ci/lint-cpp.sh         # clang-tidy over host-OS native sources (npm run lint:cpp)

vendor/wintun/           # Bundled signed wintun.dll per arch + upstream LICENSE

test/
  unit/tuntap-unit.spec.ts
  unit/tunnel/manager-forwarding.spec.ts
  integration/tuntap-integration.spec.ts
  test-tuntap.ts
  utils.ts
  check-linux-prereqs.sh
```

## Architecture

This is a Node.js native addon package that provides TUN/TAP virtual network device support for Appium iOS tunneling. It has two layers:

### Native layer (`src/tuntap.cc`, `src/native/*`)

A C++17 Node-API (NAPI) addon built via `node-gyp`. `src/tuntap.cc` is intentionally kept as the N-API interface/glue: it exposes `TunDevice` (`open()`, `close()`, `read()`, `write()`, `startPolling()`, `getName()`, `getFd()`), validates JS arguments, manages libuv polling (`uv_poll_t`), and bridges callbacks via `Napi::ThreadSafeFunction`.

Native implementation details are split into `src/native/*`:
- `TunPlatformBackend` interface in `tun_backend.h`; each backend `.cc` defines its own `CreatePlatformBackend()`
- platform-specific backends in `tun_backend_darwin.cc` (utun), `tun_backend_linux.cc` (`/dev/net/tun`), and `tun_backend_windows.cc` (WinTun via `wintun_loader.*`)
- shared POSIX base + libuv receive loop in `posix_tun_backend.h` / `posix_uv_poll_loop.*`
- RAII handles: `FileDescriptor` (POSIX) in `file_descriptor.*`, `Handle` (Win32) in `handle.*`
- tunnel forwarding in `tunnel_forwarder.*` (TLS↔TUN loops, N-API `TunnelForwarder`) and `tunnel_ssl.*` (OpenSSL client for lockdown cert or TLS-PSK)

### TypeScript layer (`src/`)

- **`errors.ts`** — shared error classes used by `TunTap` and `platform/*`.
- **`TunTap.ts`** — loads the native addon via **`node-gyp-build`** (prebuilds or `build/Release`), validates IPv6/MTU/buffers, and calls a **`TunTapPlatform`** instance chosen by **`new TunTap(name?, platform?)`** where `platform` is a **`NodeJS.Platform`** string (default `process.platform`). No custom platform object is accepted at runtime; new OS support is wired in **`platform/create-platform.ts`**.
- **`platform/*`** — OS-specific **`execFile`** usage for address, MTU, routes, and stats, each call bounded by a **30s timeout** (`exec.ts`). Darwin/Linux require **effective UID 0** (**`assertEffectiveRoot`**) and Windows requires **Administrator** (**`assertAdminOnWindows`**); commands are run **without** embedding `sudo` in argv. **`getStats`** uses read-only tooling where possible without an extra privilege check.
- **`tunnel/manager.ts`** — **`TunnelManager`**, native OpenSSL **`TunnelForwarder`**, **`connectToTunnelLockdown`** (raw TCP + pair-record PEM), and **`connectToTunnelPsk`** (TLS-PSK for Apple TV pairing).
- **`logger.ts`** — thin wrapper around `@appium/support` logger.
- **`index.ts`** — re-exports **`TunTap`**, **`PacketCallback`**, errors from **`errors.ts`**, and **`export *`** from **`tunnel/`**. Does **not** export the platform factory or concrete platform classes.

### Build output

- `prebuilds/<platform>-<arch>/*.node` — N-API binaries shipped in the npm package (built in release CI)
- `build/Release/tuntap.node` — local compile fallback (from `npm run build:addon` or `node-gyp-build` at install)
- `lib/` — compiled TypeScript output (mirrors `src/`, `scripts/`, `test/`); `lib/src/index.js` is the package entry point
- Windows source builds require static OpenSSL and `OPENSSL_ROOT_DIR` pointing at the installed triplet directory (release CI uses vcpkg `openssl:<arch>-windows-static`).

### Tests

**`node:test`** specs written as **`.ts`** ES modules under **`test/`**. Test sources import from **`src/`** (e.g. `import {TunTap} from '../src/index.js'`) so they're type-checked alongside the rest of the project by the root **`tsconfig.json`** — but they are only ever **executed from `lib/test/`** after `npm run build` compiles them to `.js`, since the `src/`-relative import specifiers only resolve correctly once mirrored into `lib/`. **`test/unit/tuntap-unit.spec.ts`** and **`test/integration/tuntap-integration.spec.ts`** (run as **`lib/test/unit/tuntap-unit.spec.js`** / **`lib/test/integration/tuntap-integration.spec.js`**) expect **root** on POSIX or an elevated PowerShell on Windows. Run test commands with `sudo` on POSIX when privileged cases are required; non-root/non-elevated runs may skip or fail depending on the case.

### Key constraints

- Only **IPv6** is supported (addresses, routes, packet parsing).
- **`configure()`**, **`addRoute()`**, and **`removeRoute()`** on built-in platforms require the process to run as **root (EUID 0)**.
- Signal handling (`SIGINT`/`SIGTERM`) is left to the caller; `TunTap` registers **`process.once('exit')`** cleanup only.
- Native **`startPolling`** is one-shot per device; stopping is done by closing the TUN fd.
