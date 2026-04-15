#!/bin/bash
set -e
cd "$(dirname "$0")"
# Use default u32 backend: despite WASM having native i64, the u64 backend
# proved slower (~196K vs 252K keys/sec) — likely due to WASM JIT not optimizing
# wide-multiply patterns as efficiently on Apple Silicon.
wasm-pack build --target web --release
# Remove wasm-pack artifacts not needed at runtime
rm -f pkg/.gitignore pkg/package.json pkg/*.d.ts
echo "Build complete. Artifacts in wasm/pkg/"
