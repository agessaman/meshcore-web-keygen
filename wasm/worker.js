import init, { generate_batch } from './pkg/meshcore_keygen.js';

let wasmReady = false;

async function ensureInit() {
    if (!wasmReady) {
        await init();
        wasmReady = true;
    }
}

function toHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

self.onmessage = async function(e) {
    const { type, batchSize, targetPrefix } = e.data;
    if (type === 'generate') {
        await ensureInit();

        // Parse target prefix into packed bytes (high-nibble-first)
        const prefix = targetPrefix.toUpperCase();
        const nibbles = prefix.length;
        const byteLen = Math.ceil(nibbles / 2);
        const prefixBytes = new Uint8Array(byteLen);
        for (let i = 0; i < nibbles; i++) {
            const nibble = parseInt(prefix[i], 16);
            if (i & 1) prefixBytes[i >>> 1] |= nibble;
            else prefixBytes[i >>> 1] = nibble << 4;
        }

        // Single WASM call for the entire batch
        const resultBuf = generate_batch(prefixBytes, nibbles, batchSize);

        // Unpack flat buffer
        const view = new DataView(resultBuf.buffer, resultBuf.byteOffset, resultBuf.byteLength);
        const matchCount = view.getUint32(0, true);
        const attempted = view.getUint32(4, true);

        const results = [];
        let offset = 8;
        for (let i = 0; i < matchCount; i++) {
            const pubkey = resultBuf.slice(offset, offset + 32); offset += 32;
            const clamped = resultBuf.slice(offset, offset + 32); offset += 32;
            const sha512SecondHalf = resultBuf.slice(offset, offset + 32); offset += 32;
            const seed = resultBuf.slice(offset, offset + 32); offset += 32;

            // Build 64-byte private key: [clamped_scalar][sha512_second_half]
            const privateKey = new Uint8Array(64);
            privateKey.set(clamped, 0);
            privateKey.set(sha512SecondHalf, 32);

            results.push({
                publicKey: toHex(pubkey),
                privateKey: toHex(privateKey),
                publicKeyBytes: Array.from(pubkey),
                privateKeyBytes: Array.from(privateKey),
                matches: true
            });
        }

        self.postMessage({ type: 'results', results, attempted });
    }
};
