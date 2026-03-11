// ============================================================
// precompute.js — Generate base point multiplication table for GPU
// Computes [0*B, 1*B, 2*B, ..., 15*B] using noble-ed25519 on CPU
// Serializes to Fe25519 limb format (16 × u32 per coordinate)
// ============================================================

// Convert a BigInt field element to 16 × u16 limbs (matching tweetnacl gf format)
function bigintToLimbs16(n, p) {
    // Ensure positive
    n = ((n % p) + p) % p;
    const limbs = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
        limbs[i] = Number(n & 0xFFFFn);
        n >>= 16n;
    }
    return limbs;
}

// Ed25519 curve parameters
const P = (1n << 255n) - 19n;
const D = ((-121665n * modInverse(121666n, P)) % P + P) % P;

function modInverse(a, m) {
    a = ((a % m) + m) % m;
    // Extended Euclidean
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return ((old_s % m) + m) % m;
}

function modPow(base, exp, mod) {
    base = ((base % mod) + mod) % mod;
    let result = 1n;
    while (exp > 0n) {
        if (exp & 1n) result = result * base % mod;
        base = base * base % mod;
        exp >>= 1n;
    }
    return result;
}

// Ed25519 base point (affine coordinates) — standard values from RFC 8032
const Bx = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const By = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

// Extended twisted Edwards point addition
// (X1:Y1:Z1:T1) + (X2:Y2:Z2:T2)
function pointAdd(p1, p2) {
    const [X1, Y1, Z1, T1] = p1;
    const [X2, Y2, Z2, T2] = p2;

    const A = (((Y1 - X1) * (Y2 - X2)) % P + P) % P;
    const B = (((Y1 + X1) * (Y2 + X2)) % P + P) % P;
    const C = ((T1 * 2n * D * T2) % P + P) % P;
    const DD = ((Z1 * 2n * Z2) % P + P) % P;
    const E = ((B - A) % P + P) % P;
    const F = ((DD - C) % P + P) % P;
    const G = ((DD + C) % P + P) % P;
    const H = ((B + A) % P + P) % P;

    return [(E * F % P + P) % P, (G * H % P + P) % P, (F * G % P + P) % P, (E * H % P + P) % P];
}

// Compute the precomputed table: [0*B, 1*B, 2*B, ..., 15*B]
// Each point in extended coordinates (X, Y, Z, T)
export function computeBaseTable() {
    const identity = [0n, 1n, 1n, 0n]; // (0:1:1:0)
    const base = [Bx, By, 1n, (Bx * By % P + P) % P]; // Base point in extended coords

    const table = [identity]; // 0*B
    let current = base;
    for (let i = 1; i < 16; i++) {
        table.push(current.map(v => ((v % P) + P) % P));
        current = pointAdd(current, base);
    }

    return table;
}

// Serialize the table to a flat Uint32Array for GPU upload
// Format: 16 points × 4 coordinates × 16 limbs = 1024 u32 values
export function serializeTableForGPU(table) {
    const data = new Uint32Array(16 * 4 * 16); // 1024 values

    for (let i = 0; i < 16; i++) {
        const [X, Y, Z, T] = table[i];
        const offset = i * 64; // 4 coords × 16 limbs

        const xLimbs = bigintToLimbs16(X, P);
        const yLimbs = bigintToLimbs16(Y, P);
        const zLimbs = bigintToLimbs16(Z, P);
        const tLimbs = bigintToLimbs16(T, P);

        for (let j = 0; j < 16; j++) {
            data[offset + j] = xLimbs[j];
            data[offset + 16 + j] = yLimbs[j];
            data[offset + 32 + j] = zLimbs[j];
            data[offset + 48 + j] = tLimbs[j];
        }
    }

    return data;
}

// Combined helper: compute and serialize
export function getBaseTableBuffer() {
    const table = computeBaseTable();
    return serializeTableForGPU(table);
}
