#!/bin/bash
set -e
cd "$(dirname "$0")"
wasm-pack build --target web --release
# Remove wasm-pack artifacts not needed at runtime
rm -f pkg/.gitignore pkg/package.json pkg/*.d.ts
echo "Build complete. Artifacts in wasm/pkg/"
