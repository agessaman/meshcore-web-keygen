/**
 * Web Worker for parallel Ed25519 key generation
 * Runs in a separate thread for true parallelism
 */

let nobleEd25519 = null;

// Initialize noble-ed25519 in the worker
async function initializeNoble() {
    if (nobleEd25519) {
        return true;
    }

    try {
        // Try ESM version first
        nobleEd25519 = await import('https://esm.sh/@noble/ed25519@2');

        // Configure SHA-512
        const hashes = await import('https://esm.sh/@noble/hashes@1/sha512');
        if (nobleEd25519.etc) {
            nobleEd25519.etc.sha512Sync = (...m) => {
                return hashes.sha512(nobleEd25519.etc.concatBytes(...m));
            };
            nobleEd25519.etc.sha512Async = async (...m) => {
                return hashes.sha512(nobleEd25519.etc.concatBytes(...m));
            };
        }
        return true;
    } catch (e1) {
        try {
            // Fallback to unpkg
            nobleEd25519 = await import('https://unpkg.com/@noble/ed25519@2/index.js');

            // Configure SHA-512 with WebCrypto
            if (nobleEd25519.etc) {
                nobleEd25519.etc.sha512Async = async (...m) => {
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
            return true;
        } catch (e2) {
            throw new Error(`Failed to load noble-ed25519: ${e2.message}`);
        }
    }
}

// Generate a single keypair from a seed
async function generateFromSeed(seed) {
    const publicKey = await nobleEd25519.getPublicKey(seed);

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
        seed: Array.from(seed),
    };
}

// Check if a public key matches the target prefix
function matchesPrefix(publicKeyHex, targetPrefix) {
    if (!targetPrefix || targetPrefix.length === 0) {
        return false;
    }
    return publicKeyHex.toLowerCase().startsWith(targetPrefix.toLowerCase());
}

// Generate random seed
function generateRandomSeed() {
    return crypto.getRandomValues(new Uint8Array(32));
}

// Main worker message handler
self.onmessage = async function(e) {
    const { type, data } = e.data;

    try {
        if (type === 'init') {
            await initializeNoble();
            self.postMessage({ type: 'init', success: true });
        } else if (type === 'generate') {
            // Ensure noble is initialized before generating
            if (!nobleEd25519) {
                await initializeNoble();
            }

            const { batchSize, targetPrefix } = data;
            const startTime = performance.now();
            const results = [];

            // Generate keys in batches for better performance
            for (let i = 0; i < batchSize; i++) {
                const seed = generateRandomSeed();
                const keypair = await generateFromSeed(seed);

                if (matchesPrefix(keypair.publicKey, targetPrefix)) {
                    results.push(keypair);
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
