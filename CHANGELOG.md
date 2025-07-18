# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2025-07-18

### Fixed
- Fixed an issue where pressing Ctrl+C (SIGINT) did not always terminate 
- the Node.js process. The signal handler now ensures all devices are closed, 
- the libuv event loop is stopped, and the process is forcefully 
- exited with `_exit(0)` if necessary.

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
