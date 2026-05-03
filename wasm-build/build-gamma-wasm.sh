#!/usr/bin/env bash
# Build Gamma → libgamma.a (WebAssembly) and package it for the editor's
# real-time audio preview. Run once per Gamma version bump.
#
# Prereqs: emsdk activated in this shell (`source emsdk_env.sh`),
#          GAMMA_DIR pointing at a Gamma checkout.
# Output:  ../assets/gamma-wasm-v1.tar.gz

set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${GAMMA_DIR:-}" ]]; then
    echo "ERROR: set GAMMA_DIR=/abs/path/to/Gamma" >&2
    exit 1
fi
if ! command -v emcmake >/dev/null 2>&1; then
    echo "ERROR: emcmake not found — source emsdk_env.sh first" >&2
    exit 1
fi
if [[ ! -f "${GAMMA_DIR}/src/Conversion.cpp" ]]; then
    echo "ERROR: GAMMA_DIR=${GAMMA_DIR} doesn't look like a Gamma checkout" >&2
    exit 1
fi

OUT_DIR="../assets"
OUT="${OUT_DIR}/gamma-wasm-v1.tar.gz"
BUILD_DIR="build-wasm"

mkdir -p "${OUT_DIR}"
rm -rf "${BUILD_DIR}"

echo ">> Configuring with emcmake (Emscripten)…"
emcmake cmake -B "${BUILD_DIR}" -S . -DGAMMA_DIR="${GAMMA_DIR}"

echo ">> Building libgamma.a…"
emmake make -C "${BUILD_DIR}" gamma -j$(nproc 2>/dev/null || echo 4)

if [[ ! -f "${BUILD_DIR}/libgamma.a" ]]; then
    echo "ERROR: build did not produce ${BUILD_DIR}/libgamma.a" >&2
    exit 1
fi

echo ">> Staging headers…"
STAGE=$(mktemp -d)
mkdir -p "${STAGE}/lib" "${STAGE}/include"
cp "${BUILD_DIR}/libgamma.a" "${STAGE}/lib/"
# Gamma's headers live at GAMMA_DIR/Gamma/*.h
cp -r "${GAMMA_DIR}/Gamma" "${STAGE}/include/"

echo ">> Packing tarball…"
( cd "${STAGE}" && tar czf "${OLDPWD}/${OUT}" lib include )
rm -rf "${STAGE}"

SIZE=$(du -h "${OUT}" | cut -f1)
SHA=$( (sha256sum "${OUT}" 2>/dev/null || shasum -a 256 "${OUT}") | cut -d' ' -f1)

echo ""
echo "✓ ${OUT}  (${SIZE})"
echo "  sha256: ${SHA}"
echo ""
echo "Next steps:"
echo "  1. Commit the artifact: git add ${OUT} && git commit -m 'Add libgamma.a v1'"
echo "  2. Push. Pages picks it up on the next deploy."
echo "  3. Click ▶ in the editor — preview should compile + play."
