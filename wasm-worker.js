/**
 * WebAssembly Ed25519 Key Generation Worker
 * Uses libsodium.js for high-performance WASM-based key generation
 */

let sodium = null;

// Initialize libsodium
async function initializeSodium() {
    if (sodium) {
        return true;
    }

    try {
        // Try loading from unpkg instead of esm.sh
        let _sodium;
        try {
            console.log('Worker: Trying to load from unpkg.com...');
            _sodium = await import('https://unpkg.com/libsodium-wrappers@0.7.13/dist/modules/libsodium-wrappers.js');
            await _sodium.ready;
            console.log('Worker: ✓ Loaded from unpkg.com');
        } catch (e1) {
            console.log('Worker: unpkg failed, trying esm.sh...');
            try {
                _sodium = await import('https://esm.sh/libsodium-wrappers@0.7.13');
                await _sodium.ready;
                console.log('Worker: ✓ Loaded from esm.sh');
            } catch (e2) {
                console.log('Worker: esm.sh failed, trying cdn.jsdelivr.net...');
                _sodium = await import('https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/modules/libsodium-wrappers.js');
                await _sodium.ready;
                console.log('Worker: ✓ Loaded from cdn.jsdelivr.net');
            }
        }

        // Handle default export (esm.sh wraps as default)
        if (_sodium.default && Object.keys(_sodium).length === 1) {
            console.log('Worker: Using default export from ESM module');
            _sodium = _sodium.default;
        }

        // Wait for ready if it's a promise
        if (_sodium.ready && typeof _sodium.ready.then === 'function') {
            console.log('Worker: Waiting for sodium.ready promise...');
            await _sodium.ready;
            console.log('Worker: sodium.ready resolved');
        }

        sodium = _sodium;

        console.log('✓ libsodium.js loaded (WebAssembly version)');
        const allKeys = Object.keys(_sodium);
        console.log('Worker: Total keys on module:', allKeys.length);
        console.log('Worker: Available libsodium functions:', allKeys.filter(k => typeof _sodium[k] === 'function').slice(0, 30));
        console.log('Worker: Sign-related functions:', allKeys.filter(k => k.includes('sign')));

        // Check if we have the required function
        if (!_sodium.crypto_sign_seed_keypair && !_sodium.crypto_sign_keypair) {
            console.error('Worker: ERROR: No crypto_sign keypair functions found!');
            console.log('Worker: All available keys:', allKeys.sort().slice(0, 50));
        }

        return true;
    } catch (error) {
        throw new Error(`Failed to load libsodium.js: ${error.message}`);
    }
}

// Generate a single keypair from a seed
function generateFromSeed(seed) {
    // libsodium expects Uint8Array seed (32 bytes)
    // Try different possible function names in libsodium.js
    let keyPair;
    if (sodium.crypto_sign_seed_keypair) {
        keyPair = sodium.crypto_sign_seed_keypair(seed);
    } else if (sodium.crypto_sign_keypair) {
        // Fallback: generate without seed (won't match our seed, but tests API)
        console.warn('crypto_sign_seed_keypair not available, trying crypto_sign_keypair');
        keyPair = sodium.crypto_sign_keypair();
    } else {
        throw new Error('No crypto_sign keypair function available. Available functions: ' +
            Object.keys(sodium).filter(k => k.includes('sign')).join(', '));
    }

    // Return raw bytes - we'll convert to hex only if needed
    return {
        publicKey: keyPair.publicKey,   // Uint8Array (32 bytes)
        privateKey: keyPair.privateKey, // Uint8Array (64 bytes)
        seed: seed,
    };
}

// Fast hex conversion for raw bytes (only used for matches)
function toHex(bytes) {
    return sodium.to_hex(bytes);
}

// Check if public key matches hex prefix (optimized for common case: 1-4 byte prefixes)
function matchesPrefix(publicKeyBytes, targetPrefix) {
    if (!targetPrefix || targetPrefix.length === 0) {
        return true; // Empty prefix matches everything
    }

    const prefix = targetPrefix.toLowerCase();
    const len = prefix.length;

    // Fast path for 2-character (1 byte) prefix like "CA"
    if (len === 2) {
        const targetByte = parseInt(prefix, 16);
        return publicKeyBytes[0] === targetByte;
    }

    // Fast path for 4-character (2 byte) prefix like "CAFE"
    if (len === 4) {
        const byte1 = parseInt(prefix.substr(0, 2), 16);
        const byte2 = parseInt(prefix.substr(2, 2), 16);
        return publicKeyBytes[0] === byte1 && publicKeyBytes[1] === byte2;
    }

    // General case for longer prefixes
    const numFullBytes = (len / 2) | 0; // Integer division
    const hasOddChar = len % 2 === 1;

    // Check full bytes
    for (let i = 0; i < numFullBytes; i++) {
        const targetByte = parseInt(prefix.substr(i * 2, 2), 16);
        if (publicKeyBytes[i] !== targetByte) {
            return false;
        }
    }

    // Check odd character (half byte) if present
    if (hasOddChar) {
        const targetNibble = parseInt(prefix[len - 1], 16);
        const actualNibble = (publicKeyBytes[numFullBytes] >> 4) & 0x0F;
        return actualNibble === targetNibble;
    }

    return true;
}

// Generate random seed using libsodium's RNG
function generateRandomSeed() {
    // libsodium.js uses randomBytes or randombytes_buf
    if (sodium.randombytes_buf) {
        return sodium.randombytes_buf(32);
    } else if (sodium.randomBytes) {
        return sodium.randomBytes(32);
    } else {
        // Fallback to Web Crypto
        return crypto.getRandomValues(new Uint8Array(32));
    }
}

// Main worker message handler
self.onmessage = async function(e) {
    const { type, data } = e.data;

    try {
        if (type === 'init') {
            await initializeSodium();
            self.postMessage({ type: 'init', success: true });
        } else if (type === 'generate') {
            // Ensure sodium is initialized before generating
            if (!sodium) {
                await initializeSodium();
            }

            const { batchSize, targetPrefix } = data;
            const startTime = performance.now();
            const results = [];

            // Pre-parse prefix for maximum performance (for 2-char "CA" prefix)
            const prefix = targetPrefix ? targetPrefix.toLowerCase() : '';
            const prefixLen = prefix.length;
            const targetByte0 = prefixLen >= 2 ? parseInt(prefix.substr(0, 2), 16) : -1;
            const targetByte1 = prefixLen >= 4 ? parseInt(prefix.substr(2, 2), 16) : -1;

            // Generate keys - libsodium WASM should be much faster
            for (let i = 0; i < batchSize; i++) {
                const seed = generateRandomSeed();
                const keypair = generateFromSeed(seed);

                // Inline prefix check for maximum speed
                let matches = false;
                if (prefixLen === 0) {
                    matches = true;
                } else if (prefixLen === 2) {
                    matches = keypair.publicKey[0] === targetByte0;
                } else if (prefixLen === 4) {
                    matches = keypair.publicKey[0] === targetByte0 && keypair.publicKey[1] === targetByte1;
                } else {
                    matches = matchesPrefix(keypair.publicKey, targetPrefix);
                }

                if (matches) {
                    // Only convert to hex for matches (rare)
                    results.push({
                        publicKey: toHex(keypair.publicKey),
                        privateKey: toHex(keypair.privateKey),
                        seed: Array.from(seed),
                    });
                }

                // Send progress updates every 1000 keys
                if ((i + 1) % 1000 === 0) {
                    self.postMessage({
                        type: 'progress',
                        processed: i + 1,
                        total: batchSize,
                        matches: results.length
                    });
                }
            }

            const totalTime = performance.now() - startTime;

            self.postMessage({
                type: 'complete',
                results,
                batchSize,
                totalTime,
                keysPerSecond: batchSize / (totalTime / 1000)
            });
        }
    } catch (error) {
        self.postMessage({
            type: 'error',
            message: error.message,
            stack: error.stack
        });
    }
};
