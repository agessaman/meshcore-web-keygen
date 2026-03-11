# WASM Performance Optimization Notes

## Problem Analysis

The initial WASM implementation was slower than expected:
- Single-threaded: ~9,180 keys/sec (only 1.25x faster than JS)
- Multi-threaded: ~29,427 keys/sec (32% efficiency, slower than JS multi at 38,986 keys/sec)

## Root Cause

The bottleneck was **NOT** the hex conversion of results (as initially suspected), but the **prefix matching check** that runs for every generated key.

### Initial "Optimization" (Failed)

**Attempt 1:** Only convert matches to hex
- Moved hex conversion inside the `if (match)` block
- Still called `matchesPrefix()` which did `byte.toString(16).padStart(2, '0')` for EVERY key
- Result: Only 1.6% improvement (9,180 → 9,326 keys/sec)
- Multi-threaded actually got WORSE (29,427 → 26,402 keys/sec)

### Final Optimization (Correct)

**Approach:** Parse prefix once, compare raw bytes with bitwise operations

**Before (per key):**
```javascript
// For "CA" prefix, this runs 250,000 times:
const byte = publicKeyBytes[0];
const hexByte = byte.toString(16).padStart(2, '0');  // Convert to "ca"
if (hexByte !== "ca") return false;
```

**After (per key):**
```javascript
// Parse once per batch: "CA" → bytes=[0xCA], mask=[0xFF]
// Then for each key:
if ((publicKeyBytes[0] & 0xFF) !== (0xCA & 0xFF)) return false;
```

**Performance Impact:**
- Eliminates 250,000 × `toString(16)` calls per batch
- Replaces string comparison with integer comparison
- Uses bitwise AND for masking (supports odd-length prefixes like "C")

## Implementation Details

### parseHexPrefix(hexPrefix)
Converts hex string "CA" → `{ bytes: [0xCA], mask: [0xFF] }`
- For even-length: Full byte match (mask = 0xFF)
- For odd-length "C": Half byte match (mask = 0xF0)

### matchesPrefixFast(publicKeyBytes, prefixData)
```javascript
for (let i = 0; i < bytes.length; i++) {
    if ((publicKeyBytes[i] & mask[i]) !== (bytes[i] & mask[i])) {
        return false;
    }
}
return true;
```

## Expected Results

With this optimization:
- **Single-threaded**: 30-40% faster (9,180 → 12,000-13,000 keys/sec)
- **Multi-threaded**: Should improve proportionally
- **Goal**: Beat JavaScript multi-threaded (38,986 keys/sec)

## Testing

Run `test-wasm-optimized.html` to measure the actual improvement.

## Lessons Learned

1. **Profile before optimizing**: The initial assumption about hex conversion overhead was wrong
2. **Look at the hot loop**: The `matchesPrefix()` function runs 250,000 times per batch
3. **Avoid string operations in hot loops**: Bitwise integer ops are much faster than `toString()`
4. **Small overhead compounds**: Even a "small" operation like `toString(16)` becomes significant at scale
