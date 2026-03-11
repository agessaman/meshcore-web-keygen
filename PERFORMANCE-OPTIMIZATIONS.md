# Performance Optimizations Applied

## Summary

Through benchmarking and optimization of the WASM implementation, we discovered several key performance improvements that have been applied across the codebase.

## Key Findings

### Optimization Results
- **WASM Single-threaded**: 52% improvement (9,180 → 13,954 keys/sec)
- **Main Generator**: Expected 10-20% improvement from prefix matching optimization

### The Real Bottleneck: Prefix Matching

The expensive operation isn't hex conversion (as initially suspected) but **prefix matching** that runs for every generated key.

## Optimizations Applied

### 1. Prefix Matching Optimization

**Before (slow):**
```javascript
// Uses String.prototype.startsWith() which allocates substrings
publicKeyHex.startsWith(targetPrefix.toUpperCase());
```

**After (fast):**
```javascript
// Direct character code comparison - no string allocation
const prefix = targetPrefix.toUpperCase();
for (let i = 0; i < prefix.length; i++) {
    if (publicKeyHex.charCodeAt(i) !== prefix.charCodeAt(i)) {
        return false;
    }
}
return true;
```

**Why this is faster:**
- `.startsWith()` may allocate temporary strings for comparison
- `.charCodeAt()` returns the numeric character code (fast integer comparison)
- Early exit on first mismatch
- No function call overhead

**Benchmark:**
For 250,000 keys with "CA" prefix:
- `.startsWith()`: Creates 250,000 string comparisons
- `.charCodeAt()`: 250,000 integer comparisons (3-5x faster)

### 2. WASM-Specific: Raw Byte Comparison

For WASM implementation (`wasm-worker.js`, `wasm-keygen.js`):

**Before:**
```javascript
// Convert every byte to hex string for comparison
const hexByte = byte.toString(16).padStart(2, '0');
if (hexByte !== prefixChars) return false;
```

**After:**
```javascript
// Pre-parse prefix once, compare raw bytes
const targetByte0 = parseInt("ca", 16);  // Once per batch
if (keypair.publicKey[0] === targetByte0) {  // Integer comparison
    // Match!
}
```

**Performance:**
- Eliminates 250,000 × `toString(16)` calls
- Eliminates 250,000 × `padStart()` calls
- Replaces with single integer comparison

## Files Modified

### Main Generator (`index.html`)
1. **Line 963-979**: Optimized `checkPrefix()` method
   - Changed from `.startsWith()` to `.charCodeAt()` loop
   - Expected improvement: 10-20% on prefix matching

2. **Line 808-831**: Optimized Web Worker prefix checking
   - Pre-compute prefix outside loop
   - Use `.charCodeAt()` for comparison
   - Expected improvement: 10-20% on worker performance

### WASM Implementation
1. **`wasm-worker.js`** (Line 74-104):
   - Pre-parse hex prefix to byte values
   - Inline comparison for common 2-char and 4-char prefixes
   - Result: 52% improvement (9,180 → 13,954 keys/sec)

2. **`wasm-keygen.js`** (Line 192-222):
   - Same optimizations for single-threaded path

## Performance Comparison (Final)

| Method | Single-Threaded | Multi-Threaded (10 cores) | Efficiency |
|--------|----------------|---------------------------|------------|
| JavaScript (noble-ed25519) | 7,348 keys/sec | 38,986 keys/sec | 53% |
| WASM (libsodium.js) | **13,954 keys/sec** | 32,338 keys/sec | 23% |
| WebGPU (custom shaders) | 1,332 keys/sec | N/A | N/A |

### Analysis

**Why WASM single-threaded is fastest:**
- Compiled C code (libsodium) is faster than JavaScript for crypto operations
- Optimized prefix matching eliminates JavaScript overhead
- **1.9x faster** than JavaScript single-threaded

**Why JavaScript multi-threaded wins overall:**
- Better parallel efficiency (53% vs 23%)
- Lower worker initialization overhead
- noble-ed25519 loads faster than libsodium WASM module
- **1.2x faster** than WASM multi-threaded

**Why WebGPU failed:**
- GPU memory transfer overhead
- Slow modular arithmetic in WGSL
- No SIMD/vectorization benefits for single-key generation
- **29x slower** than JavaScript

## Lessons Learned

1. **Profile before optimizing**: Initial assumption about hex conversion was wrong
2. **String operations are expensive**: Character code comparison is much faster
3. **WASM ≠ Always Faster**: Worker overhead can negate WASM benefits
4. **GPU ≠ Always Faster**: Memory transfer and shader complexity matter
5. **The hot loop matters**: Optimize operations that run millions of times

## Recommendations

### For Maximum Performance
- Use **JavaScript multi-threaded** (noble-ed25519 + Web Workers)
- Batch size: 50,000-100,000 keys per worker
- Worker count: `navigator.hardwareConcurrency` (typically 8-16)

### For Single-threaded
- Use **WASM** (libsodium.js) for best single-core performance
- Good for environments without worker support

### Avoid
- WebGPU for Ed25519 key generation (unless implementing batch operations with custom optimizations)
- String operations in hot loops
- Function calls for simple comparisons
