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

# Lint only the sources compile_commands.json actually has flags for — the
# host OS's conditional sources in binding.gyp. A static `src/native/*.cc`
# glob would also sweep in other platforms' sources (e.g. wintun_loader.cc on
# non-Windows), which have no compile command and fail on missing headers.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <(node -e "
const {readFileSync} = require('node:fs');
const db = JSON.parse(readFileSync('build/Release/compile_commands.json', 'utf8'));
for (const entry of db) {
  if (!entry.file.includes('/node_modules/')) console.log(entry.file);
}
")

clang-tidy -p build/Release "${extra_args[@]}" "${files[@]}"
