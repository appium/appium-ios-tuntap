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

case "$(uname -s)" in
  MINGW*|MSYS*)
    # gyp emits -fPIC from binding.gyp's shared cflags, but clang's GNU driver
    # rejects it as a hard error when targeting *-windows-msvc, so strip it
    # from the freshly generated database.
    jq 'map(.command |= gsub("-fPIC "; ""))' build/Release/compile_commands.json \
      > build/Release/compile_commands.json.tmp
    mv build/Release/compile_commands.json.tmp build/Release/compile_commands.json

    # clang-tidy resolves MSVC STL / Windows SDK headers through the INCLUDE
    # env var, which is only set inside a Visual Studio developer shell. When
    # it's missing (plain CI shell), source it from vcvars64.bat. The bat is
    # invoked via a generated wrapper because embedded quotes don't survive
    # the MSYS-to-cmd.exe argument conversion.
    if [[ -z "${INCLUDE:-}" ]]; then
      vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
      vs_path="$("$vswhere" -latest -products '*' \
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
        -property installationPath | tr -d '\r')"
      vcvars="$vs_path"'\VC\Auxiliary\Build\vcvars64.bat'
      wrapper="build/vcinclude.bat"
      printf '@echo off\r\ncall "%s" >nul 2>&1\r\nset INCLUDE\r\n' "$vcvars" > "$wrapper"
      INCLUDE="$(cmd //c "$(cygpath -w "$wrapper")" | tr -d '\r' | sed -n 's/^INCLUDE=//p')"
      rm -f "$wrapper"
      if [[ -z "$INCLUDE" ]]; then
        echo "error: could not resolve MSVC INCLUDE paths via vcvars64.bat" >&2
        exit 1
      fi
      export INCLUDE
    fi
    ;;
esac

# Lint only the sources compile_commands.json actually has flags for — the
# host OS's conditional sources in binding.gyp. A static `src/native/*.cc`
# glob would also sweep in other platforms' sources (e.g. wintun_loader.cc on
# non-Windows), which have no compile command and fail on missing headers.
# The node_modules filter (node-addon-api's nothing.c, node-gyp's
# win_delay_load_hook.cc) is a bare substring on purpose: Windows entries use
# backslash separators, and Git Bash halves doubled backslashes in arguments
# to native executables like jq.exe, so the filter must stay backslash-free.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <(jq -r '.[] | select(.file | contains("node_modules") | not) | .file' build/Release/compile_commands.json)

clang-tidy -p build/Release "${extra_args[@]}" "${files[@]}"
