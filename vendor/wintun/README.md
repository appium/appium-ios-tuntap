# WinTun (vendored)

This directory contains the unmodified, official signed [WinTun](https://www.wintun.net/) binaries that this package loads at runtime on Windows.

- **Upstream:** https://www.wintun.net/
- **Version:** 0.14.1
- **Source archive:** https://www.wintun.net/builds/wintun-0.14.1.zip
- **License:** see [`LICENSE.txt`](./LICENSE.txt). The DLLs are redistributed under the upstream prebuilt-binary license, which permits bundling unmodified copies alongside software that uses the official `wintun.h` API.

## Layout

```
vendor/wintun/
  LICENSE.txt              # Upstream license — MUST ship with the DLLs
  bin/amd64/wintun.dll     # x64 (Intel/AMD)
  bin/arm64/wintun.dll     # ARM64
  bin/x86/wintun.dll       # 32-bit Intel/AMD
  bin/arm/wintun.dll       # 32-bit ARM
```

The package's CI prebuild matrix only produces `win32-x64` and `win32-arm64` artifacts, so most users only ever load the `amd64` or `arm64` DLL. The 32-bit binaries are bundled for completeness so anyone compiling the native addon from source on `_M_IX86` / `_M_ARM` finds a matching DLL via the addon's compile-time arch lookup.

The native addon (`src/native/wintun_loader.cc`) discovers the DLL through this layout, so no install-time copy step is required.

## Refreshing the binaries

Maintainers can pull the latest official release with:

```sh
npm run refresh:wintun
```

This invokes [`scripts/fetch-wintun.mjs`](../../scripts/fetch-wintun.mjs), which downloads the ZIP from `wintun.net`, extracts the per-architecture DLLs and `LICENSE.txt` into this directory, and overwrites the existing files. Bump `WINTUN_VERSION` in that script before running.

## Do not modify

The DLLs MUST be redistributed unmodified. Do not recompile, repackage, or rename them. If you need to update WinTun, run the refresh script against a new upstream release rather than hand-editing files in this directory.
