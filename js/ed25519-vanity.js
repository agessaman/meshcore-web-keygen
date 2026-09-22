/**
 * Variable-time ed25519 arithmetic for MeshCore vanity search.
 *
 * MeshCore stores a 64-byte private key and derives the public key with
 * ge_scalarmult_base(prv[0..32]). Any clamped scalar works; bytes 32..63
 * are a signing nonce and can be random. The search therefore walks
 * s += 8, P += 8G and recovers affine y for a batch with one inversion.
 */

const P = (1n << 255n) - 19n;
const M255 = (1n << 255n) - 1n;
const D2 = 0x2406d9dc56dffce7198e80f2eef3d13000e0149a8283b156ebd69b9426b2f159n;
const Gx = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an;
const Gy = 0x6666666666666666666666666666666666666666666666666666666666666658n;

function fmod(x) {
    let lo = x & M255;
    let hi = x >> 255n;
    x = lo + hi * 19n;
    lo = x & M255;
    hi = x >> 255n;
    x = lo + hi * 19n;
    return x >= P ? x - P : x;
}

const fmul = (a, b) => fmod(a * b);
const fsqr = (a) => fmod(a * a);
const fadd = (a, b) => {
    const r = a + b;
    return r >= P ? r - P : r;
};
const fsub = (a, b) => {
    const r = a - b;
    return r < 0n ? r + P : r;
};

function finv(z) {
    const z2 = fsqr(z);
    let t = fsqr(fsqr(z2));
    const z9 = fmul(t, z);
    const z11 = fmul(z9, z2);
    const z2_5_0 = fmul(fsqr(z11), z9);
    t = z2_5_0;
    for (let i = 0; i < 5; i++) t = fsqr(t);
    const z2_10_0 = fmul(t, z2_5_0);
    t = z2_10_0;
    for (let i = 0; i < 10; i++) t = fsqr(t);
    const z2_20_0 = fmul(t, z2_10_0);
    t = z2_20_0;
    for (let i = 0; i < 20; i++) t = fsqr(t);
    const z2_40_0 = fmul(t, z2_20_0);
    t = z2_40_0;
    for (let i = 0; i < 10; i++) t = fsqr(t);
    const z2_50_0 = fmul(t, z2_10_0);
    t = z2_50_0;
    for (let i = 0; i < 50; i++) t = fsqr(t);
    const z2_100_0 = fmul(t, z2_50_0);
    t = z2_100_0;
    for (let i = 0; i < 100; i++) t = fsqr(t);
    const z2_200_0 = fmul(t, z2_100_0);
    t = z2_200_0;
    for (let i = 0; i < 50; i++) t = fsqr(t);
    t = fmul(t, z2_50_0);
    for (let i = 0; i < 5; i++) t = fsqr(t);
    return fmul(t, z11);
}

const G = [Gx, Gy, 1n, fmul(Gx, Gy)];
const IDENTITY = [0n, 1n, 1n, 0n];

const cache = (p) => [fsub(p[1], p[0]), fadd(p[1], p[0]), fmul(D2, p[3]), fadd(p[2], p[2])];

function addCached(p, c) {
    const A = fmul(fsub(p[1], p[0]), c[0]);
    const B = fmul(fadd(p[1], p[0]), c[1]);
    const C = fmul(p[3], c[2]);
    const Dz = fmul(p[2], c[3]);
    const E = fsub(B, A);
    const F = fsub(Dz, C);
    const H = fadd(B, A);
    const I = fadd(Dz, C);
    return [fmul(E, F), fmul(I, H), fmul(F, I), fmul(E, H)];
}

function dbl(p) {
    const A = fsqr(p[0]);
    const B = fsqr(p[1]);
    const C = fmod(2n * fsqr(p[2]));
    const H = fadd(A, B);
    const E = fsub(H, fsqr(fadd(p[0], p[1])));
    const I = fsub(A, B);
    const F = fadd(C, I);
    return [fmul(E, F), fmul(I, H), fmul(F, I), fmul(E, H)];
}

function scalarMulBase(k) {
    let q = IDENTITY;
    let d = G;
    while (k > 0n) {
        if (k & 1n) q = addCached(q, cache(d));
        d = dbl(d);
        k >>= 1n;
    }
    return q;
}

function batchInvert(zs, n, scratch) {
    let run = zs[0];
    scratch[0] = run;
    for (let i = 1; i < n; i++) {
        run = fmul(run, zs[i]);
        scratch[i] = run;
    }
    let inv = finv(run);
    for (let i = n - 1; i > 0; i--) {
        const zi = fmul(inv, scratch[i - 1]);
        inv = fmul(inv, zs[i]);
        zs[i] = zi;
    }
    zs[0] = inv;
}

function toBytesLE(v, len) {
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        b[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return b;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function encodePoint(p) {
    const zi = finv(p[2]);
    const x = fmul(p[0], zi);
    const y = fmul(p[1], zi);
    const b = toBytesLE(y, 32);
    b[31] |= Number(x & 1n) << 7;
    return b;
}

function clampScalar(bytes) {
    const b = Uint8Array.from(bytes);
    b[0] &= 248;
    b[31] &= 63;
    b[31] |= 64;
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(b[i]);
    return s;
}

function bytesFromScalar(s) {
    return toBytesLE(s, 32);
}

function parsePrefix(targetPrefix) {
    const prefix = targetPrefix.toUpperCase();
    const nibbles = prefix.length;
    const byteLen = Math.ceil(nibbles / 2);
    const prefixBytes = new Uint8Array(byteLen);
    for (let i = 0; i < nibbles; i++) {
        const nibble = parseInt(prefix[i], 16);
        if (i & 1) {
            prefixBytes[i >>> 1] |= nibble;
        } else {
            prefixBytes[i >>> 1] = nibble << 4;
        }
    }
    return { prefixBytes, nibbles };
}

function checkPrefix(pubkey, prefixBytes, nibbles) {
    const fullBytes = (nibbles / 2) | 0;
    for (let i = 0; i < fullBytes; i++) {
        if (pubkey[i] !== prefixBytes[i]) return false;
    }
    if (nibbles % 2 === 1 && (pubkey[fullBytes] & 0xF0) !== (prefixBytes[fullBytes] & 0xF0)) {
        return false;
    }
    return true;
}

function eightGCached() {
    const g2 = dbl(G);
    const g4 = dbl(g2);
    return cache(dbl(g4));
}

const BATCH = 512;
const STEP = 8n;
const STEP_POINT = eightGCached();

export async function searchVanityPrefix(options) {
    const {
        targetPrefix,
        shouldStop,
        onAttempted,
        progressIntervalMs = 150
    } = options;

    const { prefixBytes, nibbles } = parsePrefix(targetPrefix);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    let scalar = clampScalar(seed);
    let point = scalarMulBase(scalar);

    const Ys = new Array(BATCH);
    const Zs = new Array(BATCH);
    const points = new Array(BATCH);
    const scratch = new Array(BATCH);

    let lastYield = performance.now();

    while (!shouldStop()) {
        for (let i = 0; i < BATCH; i++) {
            scalar += STEP;
            point = addCached(point, STEP_POINT);
            points[i] = point;
            Ys[i] = point[1];
            Zs[i] = point[2];
        }
        batchInvert(Zs, BATCH, scratch);

        for (let i = 0; i < BATCH; i++) {
            const y = fmul(Ys[i], Zs[i]);
            const yBytes = toBytesLE(y, 32);
            if (yBytes[0] === 0 || yBytes[0] === 0xff) continue;
            if (!checkPrefix(yBytes, prefixBytes, nibbles)) continue;

            const pubKey = encodePoint(points[i]);
            const nonce = crypto.getRandomValues(new Uint8Array(32));
            const privateKey = new Uint8Array(64);
            privateKey.set(bytesFromScalar(scalar - STEP * BigInt(BATCH - 1 - i)), 0);
            privateKey.set(nonce, 32);

            if (typeof onAttempted === 'function') {
                onAttempted(i + 1);
            }
            return {
                publicKey: toHex(pubKey),
                privateKey: toHex(privateKey)
            };
        }

        if (typeof onAttempted === 'function') {
            onAttempted(BATCH);
        }

        const now = performance.now();
        if (now - lastYield >= progressIntervalMs) {
            lastYield = now;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    return null;
}
