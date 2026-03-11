/**
 * Web Crypto + noble-ed25519 Optimized Key Generator
 * Hybrid approach using native crypto where possible, noble-ed25519 for compatibility
 */

export class WebCryptoKeyGenerator {
    constructor() {
        this.workers = [];
        this.isInitialized = false;
        this.nobleEd25519 = null;
        this.useNativeWebCrypto = false;
    }

    /**
     * Check if native Ed25519 is supported
     */
    static async isSupported() {
        try {
            // Try to generate an Ed25519 key
            const key = await crypto.subtle.generateKey(
                { name: 'Ed25519' },
                true,
                ['sign', 'verify']
            );
            console.log('✓ Native Ed25519 support detected');
            return true;
        } catch (error) {
            console.log('⚠ Native Ed25519 not supported, will use noble-ed25519 polyfill');
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
            // Check for native support
            this.useNativeWebCrypto = await WebCryptoKeyGenerator.isSupported();

            // Load noble-ed25519 (we'll use it regardless for seed generation)
            try {
                // Try ESM version first
                this.nobleEd25519 = await import('https://esm.sh/@noble/ed25519@2');

                // Configure SHA-512
                const hashes = await import('https://esm.sh/@noble/hashes@1/sha512');
                if (this.nobleEd25519.etc) {
                    this.nobleEd25519.etc.sha512Sync = (...m) => {
                        return hashes.sha512(this.nobleEd25519.etc.concatBytes(...m));
                    };
                    this.nobleEd25519.etc.sha512Async = async (...m) => {
                        return hashes.sha512(this.nobleEd25519.etc.concatBytes(...m));
                    };
                }
                console.log('✓ noble-ed25519 loaded (esm.sh)');
            } catch (e1) {
                try {
                    // Fallback to unpkg
                    this.nobleEd25519 = await import('https://unpkg.com/@noble/ed25519@2/index.js');

                    // Configure SHA-512 with WebCrypto fallback
                    if (this.nobleEd25519.etc) {
                        this.nobleEd25519.etc.sha512Async = async (...m) => {
                            const bytes = m.reduce((acc, val) => {
                                if (val instanceof Uint8Array) {
                                    const tmp = new Uint8Array(acc.length + val.length);
                                    tmp.set(acc);
                                    tmp.set(val, acc.length);
                                    return tmp;
                                }
                                return acc;
                            }, new Uint8Array());
                            return new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
                        };
                    }
                    console.log('✓ noble-ed25519 loaded (unpkg)');
                } catch (e2) {
                    throw new Error(`Failed to load noble-ed25519: ${e2.message}`);
                }
            }

            this.isInitialized = true;
            console.log('✓ WebCrypto key generator initialized');
            return true;

        } catch (error) {
            console.error('Failed to initialize WebCrypto generator:', error);
            return false;
        }
    }

    /**
     * Generate a single keypair from a seed
     */
    async generateFromSeed(seed) {
        // Use noble-ed25519 which is highly optimized
        const publicKey = await this.nobleEd25519.getPublicKey(seed);

        // Convert to hex
        const pubKeyHex = Array.from(publicKey)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        const privKeyHex = Array.from(seed)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        return {
            publicKey: pubKeyHex,
            privateKey: privKeyHex,
            seed: seed,
        };
    }

    /**
     * Check if a public key matches the target prefix
     */
    matchesPrefix(publicKeyHex, targetPrefix) {
        if (!targetPrefix || targetPrefix.length === 0) {
            return false;
        }
        return publicKeyHex.toLowerCase().startsWith(targetPrefix.toLowerCase());
    }

    /**
     * Generate random seed
     */
    generateRandomSeed() {
        return crypto.getRandomValues(new Uint8Array(32));
    }

    /**
     * Generate a batch of keys looking for prefix matches
     * This is the main performance-critical function
     */
    async generateBatch(batchSize, targetPrefix) {
        if (!this.isInitialized) {
            throw new Error('Generator not initialized');
        }

        const startTime = performance.now();
        const results = [];
        let attempts = 0;

        // Generate seeds in batches for better performance
        const CHUNK_SIZE = 1000;

        for (let i = 0; i < batchSize; i += CHUNK_SIZE) {
            const chunkSize = Math.min(CHUNK_SIZE, batchSize - i);

            // Generate chunk of seeds
            const seeds = Array.from({ length: chunkSize }, () => this.generateRandomSeed());

            // Process in parallel using Promise.all for maximum throughput
            const keypairs = await Promise.all(
                seeds.map(seed => this.generateFromSeed(seed))
            );

            attempts += keypairs.length;

            // Check for matches
            for (const keypair of keypairs) {
                if (this.matchesPrefix(keypair.publicKey, targetPrefix)) {
                    results.push(keypair);
                }
            }
        }

        const totalTime = performance.now() - startTime;

        return {
            results,
            matchCount: results.length,
            batchSize: attempts,
            totalTime,
            keysPerSecond: attempts / (totalTime / 1000),
        };
    }

    /**
     * Generate keys using Web Workers for parallelism
     * This is the fastest approach - uses all CPU cores
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
            const worker = new Worker('./webcrypto-worker.js', { type: 'module' });
            workers.push(worker);

            const workerBatchSize = i === workerCount - 1
                ? batchSize - (keysPerWorker * i)  // Last worker gets remainder
                : keysPerWorker;

            // Create promise for this worker
            const workerPromise = new Promise((resolve, reject) => {
                let initialized = false;

                worker.onmessage = (e) => {
                    const { type, results, batchSize, totalTime, keysPerSecond, message } = e.data;

                    if (type === 'init') {
                        initialized = true;
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
        console.log('WebCrypto generator cleaned up');
    }
}
