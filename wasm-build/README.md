# Phase 4 — Building `libgamma.a` for in-browser preview

This directory contains the offline build recipe for the pre-built Gamma static-library that the editor's real-time audio preview links against. **Run this once locally** to produce `assets/gamma-wasm-v1.tar.gz`; the editor will fetch and cache it from there.

## What we're producing

A tarball containing:

- `libgamma.a` — Gamma DSP compiled to WebAssembly (Emscripten output).
- `include/Gamma/*.h` and `*.hpp` — Gamma's public headers.

Total size: ~3–5 MB. Hosted under `assets/gamma-wasm-v1.tar.gz` next to the editor (so it's served from the same origin — no CORS).

The source list and Emscripten flag set are lifted directly from [AlloLib Studio Online's `allolib-wasm/CMakeLists.txt`](https://github.com/9LiveZZZ-Git/Allolib-Studio-Online/blob/main/allolib-wasm/CMakeLists.txt) lines 80–115. We exclude `AudioIO.cpp`, `Recorder.cpp`, and `SoundFile.cpp` because they need PortAudio / libsndfile and don't apply in a browser audio-worklet context.

## Prerequisites

- **Emscripten 3.1.73 or newer.** Install via [emsdk](https://emscripten.org/docs/getting_started/downloads.html):
  ```bash
  git clone https://github.com/emscripten-core/emsdk
  cd emsdk && ./emsdk install latest && ./emsdk activate latest
  source ./emsdk_env.sh
  ```
- **CMake 3.16+**, **make**, **tar**, **git**.
- **Gamma source tree.** Clone from the AlloSphere Research Group:
  ```bash
  git clone https://github.com/AlloSphere-Research-Group/Gamma
  ```

## Build

From this directory:

```bash
# Set GAMMA_DIR to the absolute path of the Gamma checkout
export GAMMA_DIR=/abs/path/to/Gamma

./build-gamma-wasm.sh
```

The script:

1. Runs `emcmake cmake` with the bundled `CMakeLists.txt`.
2. Runs `emmake make gamma` to produce `build-wasm/libgamma.a`.
3. Tars `libgamma.a` plus Gamma's public headers into `../assets/gamma-wasm-v1.tar.gz`.
4. Prints the artifact size + sha256 so you can sanity-check.

Expected output: `assets/gamma-wasm-v1.tar.gz` (~3–5 MB).

## Verify

After the build, the editor should be able to fetch the artifact:

```bash
# From the repo root
python3 -m http.server 8000
# Visit http://localhost:8000/gamma-node-editor.html
# Click ▶ in the header. Status pill should read "compiling…" → "playing".
```

If you see "Gamma archive not found at assets/gamma-wasm-v1.tar.gz" the build either didn't run or didn't produce the tarball at the right path.

## Versioning

When you rebuild against a newer Gamma:

1. Bump the version in two places:
   - This script's `OUT=../assets/gamma-wasm-v2.tar.gz` (incrementing `v1`)
   - `gamma-node-editor.html` → `PREVIEW.gammaArchiveUrl` and `PREVIEW.gammaArchiveCacheKey`
2. Re-run `./build-gamma-wasm.sh`.
3. Commit the new tarball plus the version bump in the same PR.

The cache key change forces clients to re-download rather than serve the stale v1 from IndexedDB.

## Troubleshooting

- **"emcmake: command not found"** → run `source ./emsdk_env.sh` from the emsdk directory in your current shell.
- **"GAMMA_DIR not set"** → `export GAMMA_DIR=/path/to/Gamma` before running the script.
- **CMake configure fails on missing `Conversion.cpp`** → your Gamma checkout might be older. Stick with the `master` branch as of 2025; the file list has been stable.
- **Build succeeds but the tarball is empty** → check that `build-wasm/libgamma.a` exists. If it does, the `tar` step is what's failing — usually a path-quoting issue on Windows. Run from WSL or use the `bash` script directly.
