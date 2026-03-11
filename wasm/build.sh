#!/bin/bash
set -e
cd "$(dirname "$0")"
wasm-pack build --target web --release
echo "Build complete. Artifacts in wasm/pkg/"
