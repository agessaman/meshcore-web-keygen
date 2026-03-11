// Ed25519 Key Generation on WebGPU
// This shader implements the complete Ed25519 key generation pipeline on GPU

// SHA-512 Constants (first 64 bits of fractional parts of cube roots of first 80 primes)
const K_SHA512: array<vec2<u32>, 80> = array<vec2<u32>, 80>(
    vec2<u32>(0x428a2f98u, 0xd728ae22u), vec2<u32>(0x71374491u, 0x23ef65cdu),
    vec2<u32>(0xb5c0fbcfu, 0xec4d3b2fu), vec2<u32>(0xe9b5dba5u, 0x8189dbbcu),
    vec2<u32>(0x3956c25bu, 0xf348b538u), vec2<u32>(0x59f111f1u, 0xb605d019u),
    vec2<u32>(0x923f82a4u, 0xaf194f9bu), vec2<u32>(0xab1c5ed5u, 0xda6d8118u),
    vec2<u32>(0xd807aa98u, 0xa3030242u), vec2<u32>(0x12835b01u, 0x45706fbeu),
    vec2<u32>(0x243185beu, 0x4ee4b28cu), vec2<u32>(0x550c7dc3u, 0xd5ffb4e2u),
    vec2<u32>(0x72be5d74u, 0xf27b896fu), vec2<u32>(0x80deb1feu, 0x3b1696b1u),
    vec2<u32>(0x9bdc06a7u, 0x25c71235u), vec2<u32>(0xc19bf174u, 0xcf692694u),
    vec2<u32>(0xe49b69c1u, 0x9ef14ad2u), vec2<u32>(0xefbe4786u, 0x384f25e3u),
    vec2<u32>(0x0fc19dc6u, 0x8b8cd5b5u), vec2<u32>(0x240ca1ccu, 0x77ac9c65u),
    vec2<u32>(0x2de92c6fu, 0x592b0275u), vec2<u32>(0x4a7484aau, 0x6ea6e483u),
    vec2<u32>(0x5cb0a9dcu, 0xbd41fbd4u), vec2<u32>(0x76f988dau, 0x831153b5u),
    vec2<u32>(0x983e5152u, 0xee66dfabu), vec2<u32>(0xa831c66du, 0x2db43210u),
    vec2<u32>(0xb00327c8u, 0x98fb213fu), vec2<u32>(0xbf597fc7u, 0xbeef0ee4u),
    vec2<u32>(0xc6e00bf3u, 0x3da88fc2u), vec2<u32>(0xd5a79147u, 0x930aa725u),
    vec2<u32>(0x06ca6351u, 0xe003826fu), vec2<u32>(0x14292967u, 0x0a0e6e70u),
    vec2<u32>(0x27b70a85u, 0x46d22ffcu), vec2<u32>(0x2e1b2138u, 0x5c26c926u),
    vec2<u32>(0x4d2c6dfcu, 0x5ac42aedu), vec2<u32>(0x53380d13u, 0x9d95b3dfu),
    vec2<u32>(0x650a7354u, 0x8baf63deu), vec2<u32>(0x766a0abbu, 0x3c77b2a8u),
    vec2<u32>(0x81c2c92eu, 0x47edaee6u), vec2<u32>(0x92722c85u, 0x1482353bu),
    vec2<u32>(0xa2bfe8a1u, 0x4cf10364u), vec2<u32>(0xa81a664bu, 0xbc423001u),
    vec2<u32>(0xc24b8b70u, 0xd0f89791u), vec2<u32>(0xc76c51a3u, 0x0654be30u),
    vec2<u32>(0xd192e819u, 0xd6ef5218u), vec2<u32>(0xd6990624u, 0x5565a910u),
    vec2<u32>(0xf40e3585u, 0x5771202au), vec2<u32>(0x106aa070u, 0x32bbd1b8u),
    vec2<u32>(0x19a4c116u, 0xb8d2d0c8u), vec2<u32>(0x1e376c08u, 0x5141ab53u),
    vec2<u32>(0x2748774cu, 0xdf8eeb99u), vec2<u32>(0x34b0bcb5u, 0xe19b48a8u),
    vec2<u32>(0x391c0cb3u, 0xc5c95a63u), vec2<u32>(0x4ed8aa4au, 0xe3418acbu),
    vec2<u32>(0x5b9cca4fu, 0x7763e373u), vec2<u32>(0x682e6ff3u, 0xd6b2b8a3u),
    vec2<u32>(0x748f82eeu, 0x5defb2fcu), vec2<u32>(0x78a5636fu, 0x43172f60u),
    vec2<u32>(0x84c87814u, 0xa1f0ab72u), vec2<u32>(0x8cc70208u, 0x1a6439ecu),
    vec2<u32>(0x90befffau, 0x23631e28u), vec2<u32>(0xa4506cebu, 0xde82bde9u),
    vec2<u32>(0xbef9a3f7u, 0xb2c67915u), vec2<u32>(0xc67178f2u, 0xe372532bu),
    vec2<u32>(0xca273eceu, 0xea26619cu), vec2<u32>(0xd186b8c7u, 0x21c0c207u),
    vec2<u32>(0xeada7dd6u, 0xcde0eb1eu), vec2<u32>(0xf57d4f7fu, 0xee6ed178u),
    vec2<u32>(0x06f067aau, 0x72176fbau), vec2<u32>(0x0a637dc5u, 0xa2c898a6u),
    vec2<u32>(0x113f9804u, 0xbef90daeu), vec2<u32>(0x1b710b35u, 0x131c471bu),
    vec2<u32>(0x28db77f5u, 0x23047d84u), vec2<u32>(0x32caab7bu, 0x40c72493u),
    vec2<u32>(0x3c9ebe0au, 0x15c9bebcu), vec2<u32>(0x431d67c4u, 0x9c100d4cu),
    vec2<u32>(0x4cc5d4beu, 0xcb3e42b6u), vec2<u32>(0x597f299cu, 0xfc657e2au),
    vec2<u32>(0x5fcb6fabu, 0x3ad6faecu), vec2<u32>(0x6c44198cu, 0x4a475817u)
);

// SHA-512 initial hash values
const H0_SHA512: array<vec2<u32>, 8> = array<vec2<u32>, 8>(
    vec2<u32>(0x6a09e667u, 0xf3bcc908u), vec2<u32>(0xbb67ae85u, 0x84caa73bu),
    vec2<u32>(0x3c6ef372u, 0xfe94f82bu), vec2<u32>(0xa54ff53au, 0x5f1d36f1u),
    vec2<u32>(0x510e527fu, 0xade682d1u), vec2<u32>(0x9b05688cu, 0x2b3e6c1fu),
    vec2<u32>(0x1f83d9abu, 0xfb41bd6bu), vec2<u32>(0x5be0cd19u, 0x137e2179u)
);

// 64-bit operations using vec2<u32> (hi, lo)
fn add64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let lo = a.y + b.y;
    let carry = u32(lo < a.y);
    let hi = a.x + b.x + carry;
    return vec2<u32>(hi, lo);
}

fn rotr64(x: vec2<u32>, n: u32) -> vec2<u32> {
    if (n == 0u) { return x; }
    if (n < 32u) {
        return vec2<u32>(
            (x.x >> n) | (x.y << (32u - n)),
            (x.y >> n) | (x.x << (32u - n))
        );
    } else {
        let n2 = n - 32u;
        return vec2<u32>(
            (x.y >> n2) | (x.x << (32u - n2)),
            (x.x >> n2) | (x.y << (32u - n2))
        );
    }
}

fn shr64(x: vec2<u32>, n: u32) -> vec2<u32> {
    if (n == 0u) { return x; }
    if (n < 32u) {
        return vec2<u32>(x.x >> n, (x.y >> n) | (x.x << (32u - n)));
    } else {
        return vec2<u32>(0u, x.x >> (n - 32u));
    }
}

fn ch64(x: vec2<u32>, y: vec2<u32>, z: vec2<u32>) -> vec2<u32> {
    return vec2<u32>((x.x & y.x) ^ (~x.x & z.x), (x.y & y.y) ^ (~x.y & z.y));
}

fn maj64(x: vec2<u32>, y: vec2<u32>, z: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(
        (x.x & y.x) ^ (x.x & z.x) ^ (y.x & z.x),
        (x.y & y.y) ^ (x.y & z.y) ^ (y.y & z.y)
    );
}

fn sigma0_512(x: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(
        rotr64(x, 28u).x ^ rotr64(x, 34u).x ^ rotr64(x, 39u).x,
        rotr64(x, 28u).y ^ rotr64(x, 34u).y ^ rotr64(x, 39u).y
    );
}

fn sigma1_512(x: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(
        rotr64(x, 14u).x ^ rotr64(x, 18u).x ^ rotr64(x, 41u).x,
        rotr64(x, 14u).y ^ rotr64(x, 18u).y ^ rotr64(x, 41u).y
    );
}

fn gamma0_512(x: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(
        rotr64(x, 1u).x ^ rotr64(x, 8u).x ^ shr64(x, 7u).x,
        rotr64(x, 1u).y ^ rotr64(x, 8u).y ^ shr64(x, 7u).y
    );
}

fn gamma1_512(x: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(
        rotr64(x, 19u).x ^ rotr64(x, 61u).x ^ shr64(x, 6u).x,
        rotr64(x, 19u).y ^ rotr64(x, 61u).y ^ shr64(x, 6u).y
    );
}

// SHA-512 compression function
fn sha512_compress(state: ptr<function, array<vec2<u32>, 8>>, block: array<vec2<u32>, 16>) {
    var w: array<vec2<u32>, 80>;

    // Prepare message schedule
    for (var i = 0u; i < 16u; i++) {
        w[i] = block[i];
    }
    for (var i = 16u; i < 80u; i++) {
        w[i] = add64(add64(add64(gamma1_512(w[i - 2u]), w[i - 7u]), gamma0_512(w[i - 15u])), w[i - 16u]);
    }

    // Initialize working variables
    var a = (*state)[0];
    var b = (*state)[1];
    var c = (*state)[2];
    var d = (*state)[3];
    var e = (*state)[4];
    var f = (*state)[5];
    var g = (*state)[6];
    var h = (*state)[7];

    // Main loop
    for (var i = 0u; i < 80u; i++) {
        let t1 = add64(add64(add64(add64(h, sigma1_512(e)), ch64(e, f, g)), K_SHA512[i]), w[i]);
        let t2 = add64(sigma0_512(a), maj64(a, b, c));
        h = g;
        g = f;
        f = e;
        e = add64(d, t1);
        d = c;
        c = b;
        b = a;
        a = add64(t1, t2);
    }

    // Add compressed chunk to state
    (*state)[0] = add64((*state)[0], a);
    (*state)[1] = add64((*state)[1], b);
    (*state)[2] = add64((*state)[2], c);
    (*state)[3] = add64((*state)[3], d);
    (*state)[4] = add64((*state)[4], e);
    (*state)[5] = add64((*state)[5], f);
    (*state)[6] = add64((*state)[6], g);
    (*state)[7] = add64((*state)[7], h);
}

// Compute SHA-512 of 32-byte seed
fn compute_sha512(seed: array<u32, 8>) -> array<u32, 16> {
    var state = H0_SHA512;

    // Prepare message block (32 bytes + padding to 128 bytes)
    var block: array<vec2<u32>, 16>;

    // Convert seed to big-endian vec2<u32>
    for (var i = 0u; i < 4u; i++) {
        block[i] = vec2<u32>(seed[i * 2u], seed[i * 2u + 1u]);
    }

    // Padding: 0x80 byte, then zeros, then 128-bit length (256 bits)
    block[4] = vec2<u32>(0x80000000u, 0u);
    for (var i = 5u; i < 15u; i++) {
        block[i] = vec2<u32>(0u, 0u);
    }
    block[15] = vec2<u32>(0u, 256u); // Length in bits (32 bytes * 8)

    // Compress
    sha512_compress(&state, block);

    // Convert back to u32 array
    var result: array<u32, 16>;
    for (var i = 0u; i < 8u; i++) {
        result[i * 2u] = state[i].x;
        result[i * 2u + 1u] = state[i].y;
    }

    return result;
}

// Ed25519 scalar clamping
fn clamp_scalar(scalar: ptr<function, array<u32, 8>>) {
    (*scalar)[7] = (*scalar)[7] & 0xFFFFFFF8u;  // Clear bottom 3 bits (byte 0)
    (*scalar)[0] = (*scalar)[0] & 0x7FFFFFFFu;  // Clear top bit (byte 31)
    (*scalar)[0] = (*scalar)[0] | 0x40000000u;  // Set second-to-top bit (byte 31)
}

// Storage buffers
struct Params {
    batch_size: u32,
    target_prefix_len: u32,
    base_seed: u32,
    padding: u32,
}

struct KeyPair {
    found: u32,
    public_key: array<u32, 8>,   // 32 bytes
    private_key: array<u32, 16>,  // 64 bytes
    seed: array<u32, 8>,          // Original seed for debugging
    padding: array<u32, 3>,
}

@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read> target_prefix: array<u32, 8>;
@group(0) @binding(2) var<storage, read_write> results: array<KeyPair>;
@group(0) @binding(3) var<storage, read_write> match_count: atomic<u32>;

// Simple PRNG for deterministic seed generation
fn xorshift32(state: ptr<function, u32>) -> u32 {
    var x = *state;
    x = x ^ (x << 13u);
    x = x ^ (x >> 17u);
    x = x ^ (x << 5u);
    *state = x;
    return x;
}

// Check if public key matches target prefix (comparing hex nibbles)
fn matches_prefix(pubkey: array<u32, 8>, prefix: array<u32, 8>, prefix_len: u32) -> bool {
    if (prefix_len == 0u) {
        return false;
    }

    // Each hex character is 4 bits (nibble)
    // We need to compare prefix_len nibbles
    let full_bytes = prefix_len / 2u;
    let has_half_byte = (prefix_len % 2u) == 1u;

    // Compare full bytes
    for (var i = 0u; i < full_bytes; i++) {
        let byte_idx = i / 4u;  // Which u32
        let shift = (3u - (i % 4u)) * 8u;  // Shift within u32

        let pub_byte = (pubkey[byte_idx] >> shift) & 0xFFu;
        let prefix_byte = (prefix[byte_idx] >> shift) & 0xFFu;

        if (pub_byte != prefix_byte) {
            return false;
        }
    }

    // Compare half byte if prefix length is odd
    if (has_half_byte) {
        let i = full_bytes;
        let byte_idx = i / 4u;
        let shift = (3u - (i % 4u)) * 8u;

        let pub_nibble = ((pubkey[byte_idx] >> shift) & 0xF0u) >> 4u;
        let prefix_nibble = ((prefix[byte_idx] >> shift) & 0xF0u) >> 4u;

        if (pub_nibble != prefix_nibble) {
            return false;
        }
    }

    return true;
}

// Ed25519 scalar multiplication
// This will be replaced by ed25519_scalar_mult_base_impl from ed25519-curve.wgsl
// when the shaders are concatenated
fn ed25519_scalar_mult_base(scalar: array<u32, 8>) -> array<u32, 8> {
    // The actual implementation is in ed25519-curve.wgsl
    // JavaScript will concatenate: i256.wgsl + ed25519-curve.wgsl + ed25519-gpu.wgsl

    // Call the implementation function
    return ed25519_scalar_mult_base_impl(scalar);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let idx = global_id.x;

    if (idx >= params.batch_size) {
        return;
    }

    // Generate deterministic seed
    var seed: array<u32, 8>;
    var rng_state = params.base_seed + idx;
    for (var i = 0u; i < 8u; i++) {
        seed[i] = xorshift32(&rng_state);
    }

    // Step 1: Hash seed with SHA-512
    let hash = compute_sha512(seed);

    // Step 2: Extract and clamp scalar (first 32 bytes)
    var scalar: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        scalar[i] = hash[i];
    }
    clamp_scalar(&scalar);

    // Step 3: Scalar multiplication to get public key
    // NOTE: This needs proper Ed25519 implementation with i256
    let pubkey = ed25519_scalar_mult_base(scalar);

    // Step 4: Check if matches target prefix
    if (matches_prefix(pubkey, target_prefix, params.target_prefix_len)) {
        let result_idx = atomicAdd(&match_count, 1u);

        if (result_idx < 1024u) {  // Limit results buffer
            results[result_idx].found = 1u;
            results[result_idx].public_key = pubkey;

            // Private key is scalar + second half of hash
            for (var i = 0u; i < 8u; i++) {
                results[result_idx].private_key[i] = scalar[i];
                results[result_idx].private_key[i + 8u] = hash[i + 8u];
            }

            results[result_idx].seed = seed;
        }
    }
}
