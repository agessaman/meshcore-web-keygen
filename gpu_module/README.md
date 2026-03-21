# GPU Module

This folder contains the WebGPU acceleration path for MeshCore vanity key generation.

## What lives here

- `src/webgpu-ed25519.js`: the main scanner module. It uploads candidate Ed25519 scalars to the GPU, runs the WGSL kernel, and returns match flags for a requested public-key prefix.
- `src/webgpu-ed25519-table.js`: generated precomputation data used by the shader for fast fixed-base scalar multiplication. Do not hand-edit this file.
- `scripts/build-ed25519-table.mjs`: regenerates the precomputed lookup table from `@noble/ed25519`.
- `scripts/build-gpu-module.mjs`: bundles the table and scanner into a single browser script exposed as `window.MeshCoreGpuModule`.

## General architecture

The runtime path is split into two parts:

1. CPU hash workers in `src/app.js` generate candidate Ed25519 private scalars from random seeds.
2. `WebGpuEd25519Scanner` in this folder scans those scalars on the GPU and returns a flag array indicating which candidates match the requested public-key prefix.

The app keeps CPU derivation as the final correctness gate. WebGPU is only used to accelerate the bulk prefix scan.

## Build

From the repo root:

```bash
npm run build:gpu
```

That runs both module-local steps:

```bash
npm --prefix gpu_module run build:table
npm --prefix gpu_module run build:module
```

The final browser bundle is written to the repo root as `webgpu-ed25519.js`.

## Tests

From the repo root:

```bash
npm test
```

The Playwright suite checks that:

- GPU match flags agree with CPU-derived Ed25519 public keys on a sampled batch.
- End-to-end key generation still returns a CPU-validated result.

If WebGPU is unavailable in the test browser, the GPU-specific assertion is skipped by the test itself.
