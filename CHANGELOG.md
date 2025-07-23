## [0.0.6](https://github.com/appium/appium-ios-tuntap/compare/v0.0.5...v0.0.6) (2025-07-23)

### Miscellaneous Chores

* Apply standard Appium linter ([#11](https://github.com/appium/appium-ios-tuntap/issues/11)) ([a55693a](https://github.com/appium/appium-ios-tuntap/commit/a55693a90cca41f54ced506404b8456ea6994875))

## [0.0.5](https://github.com/appium/appium-ios-tuntap/compare/v0.0.4...v0.0.5) (2025-07-23)

### Bug Fixes

* hard link release issue ([#10](https://github.com/appium/appium-ios-tuntap/issues/10)) ([e7152b7](https://github.com/appium/appium-ios-tuntap/commit/e7152b7af519425d2045e61719fd460c251db391))

## [0.0.4](https://github.com/appium/appium-ios-tuntap/compare/v0.0.3...v0.0.4) (2025-07-22)

### Miscellaneous Chores

* **deps-dev:** bump @types/node from 22.16.5 to 24.1.0 ([#9](https://github.com/appium/appium-ios-tuntap/issues/9)) ([60a0d4b](https://github.com/appium/appium-ios-tuntap/commit/60a0d4beb1e36b4ccbf73a0cacda1179df75c834))

## [0.0.3](https://github.com/appium/appium-ios-tuntap/compare/v0.0.2...v0.0.3) (2025-07-22)

### Bug Fixes

* ensure clean shutdown and resource release on SIGINT (Ctrl+C) ([#1](https://github.com/appium/appium-ios-tuntap/issues/1)) ([d527960](https://github.com/appium/appium-ios-tuntap/commit/d5279605ac30a253382cbcd932926edd5dc285a2))

## [0.0.2](https://github.com/appium/appium-ios-tuntap/compare/v0.0.1...v0.0.2) (2025-07-22)

### Miscellaneous Chores

* update changelog to release it ([4e8fe0a](https://github.com/appium/appium-ios-tuntap/commit/4e8fe0a610a908c2f3a56bff7031f7580eb011c1))

## [0.0.1] - [2025-07-22]

### Features

* add packet streaming api instead of eventEmitter ([8c4df4b](https://github.com/appium/appium-ios-tuntap/commit/8c4df4bace59c2b29a567e2f9c81b1737500c42b))

### Bug Fixes

* add proper headers for linux ([967ea00](https://github.com/appium/appium-ios-tuntap/commit/967ea007b198f77f7e3aaaa1489dc5a0977bc5e6))
* add test to ci ([8753e01](https://github.com/appium/appium-ios-tuntap/commit/8753e0109f0ad4120ac4db1318c103fc2be0f7c7))

### Miscellaneous Chores

* add semantics release ([#7](https://github.com/appium/appium-ios-tuntap/issues/7)) ([a52b2e6](https://github.com/appium/appium-ios-tuntap/commit/a52b2e6010e99f1e5518726a93b313efab6475fb))
* **release:** bump version to 0.0.2 ([ed690cf](https://github.com/appium/appium-ios-tuntap/commit/ed690cfcc56c22a33cfc303960b46091619fe7e1))
* **release:** initial release of tuntap-bridge npm package v0.0.1 ([0b68aea](https://github.com/appium/appium-ios-tuntap/commit/0b68aeaae2af9d0a7af386055f3667b6826c6d22))
* turn release ([#8](https://github.com/appium/appium-ios-tuntap/issues/8)) ([3efc5a4](https://github.com/appium/appium-ios-tuntap/commit/3efc5a4eb7cb4e4f59daffb2623ead811292fa69))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2025-07-18

### Changed
- **Shutdown Responsibility**: Refactored the shutdown logic to be managed entirely by the TypeScript application layer, removing the signal handler from the C++ addon. This creates a single, reliable source of truth for shutdown orchestration and resolves the race condition.
- **Improved Thread Safety**: Hardened mutex locking around all public C++ methods to prevent potential race conditions during concurrent access.
- **Memory Safety**: Implemented smart pointers (`std::unique_ptr`) for libuv handle management in the C++ addon to prevent potential memory leaks.

### Fixed
- **Process Hanging on Shutdown**: Resolved an issue where the Node.js process would hang on `Ctrl+C` (SIGINT). This was caused by a race condition between competing signal handlers in the C++ addon and the TypeScript application layer.


## [0.0.3] - 2025-01-07

### Added
- Signal handling for graceful shutdown (SIGINT/SIGTERM)
- Thread safety with mutex protection in C++ code
- Custom error types for better error handling:
  - `TunTapError` - Base error class
  - `TunTapPermissionError` - Permission-related errors
  - `TunTapDeviceError` - Device availability errors
- Input validation for all methods:
  - IPv6 address format validation
  - MTU range checking (1280-65535)
  - Buffer size validation
  - Type checking for all parameters
- New methods:
  - `removeRoute()` - Remove routes from the interface
  - `getStats()` - Get network interface statistics
- Resource cleanup handlers for automatic cleanup on process exit
- Timeout handling for network operations
- Memory leak prevention with RAII pattern
- Debug logging support with `--debug` flag
- Comprehensive test suite

### Changed
- Updated to C++17 standard for better performance and modern features
- Improved error messages with more context and suggestions
- Enhanced buffer management to reduce memory allocations
- Better handling of concurrent operations
- Optimized compilation with `-O3` flag
- Improved TypeScript type definitions

### Fixed
- File descriptor leaks on error conditions
- Resource cleanup on unexpected process termination
- Race conditions in multi-threaded environments
- Memory leaks in error paths
- Proper cleanup of network interfaces on shutdown
- Better error handling for permission issues

### Security
- Added proper bounds checking for all buffer operations
- Validated all user inputs to prevent invalid operations
- Thread-safe operations to prevent race conditions

## [0.0.2] - Previous Release

### Added
- Basic TUN/TAP device support for macOS and Linux
- TypeScript support
- Basic read/write operations
- IPv6 configuration support

## [0.0.1] - Initial Release

### Added
- Initial implementation of TUN/TAP bridge
- Support for creating virtual network interfaces
- Basic documentation
