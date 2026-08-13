#!/usr/bin/env bash
# Runs clang-tidy over the native sources compiled for the host OS.
# On macOS, Homebrew's clang-tidy doesn't share Xcode's SDK auto-discovery,
# so `cstddef` and friends resolve as "file not found" unless the SDK is
# passed explicitly via -isysroot.
set -euo pipefail

extra_args=()
if [[ "$(uname)" == "Darwin" ]]; then
  extra_args+=("--extra-arg=-isysroot$(xcrun --show-sdk-path)")
fi

clang-tidy -p build/Release "${extra_args[@]}" src/tuntap.cc src/native/*.cc
