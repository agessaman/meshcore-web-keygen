/**
 * WebAssembly (libsodium.js) Ed25519 Key Generator
 * High-performance WASM-based key generation with Web Workers
 */

export class WasmKeyGenerator {
    constructor() {
        this.workers = [];
        this.isInitialized = false;
        this.sodium = null;
    }

    /**
     * Check if libsodium.js can be loaded
     */
    static async isSupported() {
        try {
            const _sodium = await import('https://esm.sh/libsodium-wrappers@0.7.13');
            await _sodium.ready;
            console.log('✓ libsodium.js WebAssembly support detected');
            return true;
        } catch (error) {
            console.log('⚠ libsodium.js not available:', error.message);
            return false;
        }
    }

    /**
     * Initialize the generator
     */
    async initialize() {
        if (this.isInitialized) {
            return true;
        }

        try {
            // Try loading from unpkg instead of esm.sh
            let _sodium;
            try {
                console.log('Trying to load from unpkg.com...');
                _sodium = await import('https://unpkg.com/libsodium-wrappers@0.7.13/dist/modules/libsodium-wrappers.js');
                await _sodium.ready;
                console.log('✓ Loaded from unpkg.com');
            } catch (e1) {
                console.log('unpkg failed, trying esm.sh...');
                try {
                    _sodium = await import('https://esm.sh/libsodium-wrappers@0.7.13');
                    await _sodium.ready;
                    console.log('✓ Loaded from esm.sh');
                } catch (e2) {
                    console.log('esm.sh failed, trying cdn.jsdelivr.net...');
                    _sodium = await import('https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/modules/libsodium-wrappers.js');
                    await _sodium.ready;
                    console.log('✓ Loaded from cdn.jsdelivr.net');
                }
            }

            // Handle default export (esm.sh wraps as default)
            if (_sodium.default && Object.keys(_sodium).length === 1) {
                console.log('Using default export from ESM module');
                _sodium = _sodium.default;
            }

            // Wait for ready if it's a promise
            if (_sodium.ready && typeof _sodium.ready.then === 'function') {
                console.log('Waiting for sodium.ready promise...');
                await _sodium.ready;
                console.log('sodium.ready resolved');
            }

            this.sodium = _sodium;

            // Debug: Log available functions
            console.log('✓ WASM key generator initialized');
            const allKeys = Object.keys(_sodium);
            console.log('Total keys on module:', allKeys.length);
            console.log('Available libsodium functions:', allKeys.filter(k => typeof _sodium[k] === 'function').slice(0, 30));
            console.log('Sign-related functions:', allKeys.filter(k => k.includes('sign')));

            // Check if we have the required function
            if (!_sodium.crypto_sign_seed_keypair && !_sodium.crypto_sign_keypair) {
                console.error('ERROR: No crypto_sign keypair functions found!');
                console.log('All available keys:', allKeys.sort().slice(0, 50));
            }

            this.isInitialized = true;
            return true;

        } catch (error) {
            console.error('Failed to initialize WASM generator:', error);
            return false;
        }
    }

    /**
     * Generate a single keypair from a seed (main thread)
     */
    generateFromSeed(seed) {
        // Try different possible function names in libsodium.js
        let keyPair;
        if (this.sodium.crypto_sign_seed_keypair) {
            keyPair = this.sodium.crypto_sign_seed_keypair(seed);
        } else if (this.sodium.crypto_sign_keypair) {
            // Fallback: generate without seed (won't match our seed, but tests API)
            console.warn('crypto_sign_seed_keypair not available, trying crypto_sign_keypair');
            keyPair = this.sodium.crypto_sign_keypair();
        } else {
            throw new Error('No crypto_sign keypair function available. Available functions: ' +
                Object.keys(this.sodium).filter(k => k.includes('sign')).join(', '));
        }

        // Return raw bytes - we'll convert to hex only if needed
        return {
            publicKey: keyPair.publicKey,   // Uint8Array (32 bytes)
            privateKey: keyPair.privateKey, // Uint8Array (64 bytes)
            seed: seed,
        };
    }

    /**
     * Check if public key matches hex prefix (optimized for common case: 1-4 byte prefixes)
     */
    matchesPrefix(publicKeyBytes, targetPrefix) {
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

    /**
     * Generate random seed
     */
    generateRandomSeed() {
        // libsodium.js uses randomBytes or randombytes_buf
        if (this.sodium.randombytes_buf) {
            return this.sodium.randombytes_buf(32);
        } else if (this.sodium.randomBytes) {
            return this.sodium.randomBytes(32);
        } else {
            // Fallback to Web Crypto
            return crypto.getRandomValues(new Uint8Array(32));
        }
    }

    /**
     * Generate a batch of keys (single-threaded, for comparison)
     */
    async generateBatch(batchSize, targetPrefix) {
        if (!this.isInitialized) {
            throw new Error('Generator not initialized');
        }

        const startTime = performance.now();
        const results = [];

        // Pre-parse prefix for maximum performance (for 2-char "CA" prefix)
        const prefix = targetPrefix ? targetPrefix.toLowerCase() : '';
        const prefixLen = prefix.length;
        const targetByte0 = prefixLen >= 2 ? parseInt(prefix.substr(0, 2), 16) : -1;
        const targetByte1 = prefixLen >= 4 ? parseInt(prefix.substr(2, 2), 16) : -1;

        for (let i = 0; i < batchSize; i++) {
            const seed = this.generateRandomSeed();
            const keypair = this.generateFromSeed(seed);

            // Inline prefix check for maximum speed
            let matches = false;
            if (prefixLen === 0) {
                matches = true;
            } else if (prefixLen === 2) {
                matches = keypair.publicKey[0] === targetByte0;
            } else if (prefixLen === 4) {
                matches = keypair.publicKey[0] === targetByte0 && keypair.publicKey[1] === targetByte1;
            } else {
                matches = this.matchesPrefix(keypair.publicKey, targetPrefix);
            }

            if (matches) {
                // Only convert to hex for matches (rare)
                results.push({
                    publicKey: this.sodium.to_hex(keypair.publicKey),
                    privateKey: this.sodium.to_hex(keypair.privateKey),
                    seed: Array.from(seed),
                });
            }
        }

        const totalTime = performance.now() - startTime;

        return {
            results,
            matchCount: results.length,
            batchSize,
            totalTime,
            keysPerSecond: batchSize / (totalTime / 1000),
        };
    }

    /**
     * Generate keys using Web Workers for parallelism
     * This is the fastest approach - uses all CPU cores with WASM
     */
    async generateBatchParallel(batchSize, targetPrefix, workerCount = navigator.hardwareConcurrency || 4) {
        if (!this.isInitialized) {
            throw new Error('Generator not initialized');
        }

        const startTime = performance.now();

        // Split work across workers
        const keysPerWorker = Math.ceil(batchSize / workerCount);

        // Create workers
        const workers = [];
        const workerPromises = [];

        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker('./wasm-worker.js', { type: 'module' });
            workers.push(worker);

            const workerBatchSize = i === workerCount - 1
                ? batchSize - (keysPerWorker * i)  // Last worker gets remainder
                : keysPerWorker;

            // Create promise for this worker
            const workerPromise = new Promise((resolve, reject) => {
                worker.onmessage = (e) => {
                    const { type, results, batchSize, totalTime, keysPerSecond, message } = e.data;

                    if (type === 'init') {
                        // Start generation after initialization completes
                        worker.postMessage({
                            type: 'generate',
                            data: { batchSize: workerBatchSize, targetPrefix }
                        });
                    } else if (type === 'complete') {
                        resolve({ results, batchSize, totalTime, keysPerSecond });
                    } else if (type === 'error') {
                        reject(new Error(message));
                    }
                    // Ignore 'progress' messages
                };

                worker.onerror = (error) => {
                    reject(error);
                };

                // Initialize worker
                worker.postMessage({ type: 'init' });
            });

            workerPromises.push(workerPromise);
        }

        try {
            // Wait for all workers to complete
            const workerResults = await Promise.all(workerPromises);

            // Combine results
            const allResults = workerResults.flatMap(r => r.results);
            const totalAttempts = workerResults.reduce((sum, r) => sum + r.batchSize, 0);
            const totalTime = performance.now() - startTime;

            return {
                results: allResults,
                matchCount: allResults.length,
                batchSize: totalAttempts,
                totalTime,
                keysPerSecond: totalAttempts / (totalTime / 1000),
            };
        } finally {
            // Cleanup workers
            workers.forEach(worker => worker.terminate());
        }
    }

    /**
     * Cleanup resources
     */
    destroy() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.isInitialized = false;
        console.log('WASM generator cleaned up');
    }
}
