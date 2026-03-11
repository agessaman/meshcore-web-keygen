/**
 * WebGPU-accelerated Ed25519 Key Generation (Hybrid Approach)
 *
 * This implementation uses a hybrid CPU/GPU approach:
 * - GPU: Generates random seeds in parallel and hashes them with SHA-512
 * - CPU: Performs Ed25519 scalar multiplication (requires 256-bit arithmetic)
 *
 * This approach still provides significant speedup because:
 * 1. Seed generation is parallelized on GPU
 * 2. SHA-512 hashing is done on GPU (most crypto libraries don't parallelize this)
 * 3. Only matching candidates need CPU verification
 */

// WGSL shader for seed generation and SHA-512 hashing
const sha512ComputeShader = `
// SHA-512 constants (round constants)
const K: array<u64, 80> = array<u64, 80>(
    0x428a2f98d728ae22u, 0x7137449123ef65cdu, 0xb5c0fbcfec4d3b2fu, 0xe9b5dba58189dbbcu,
    0x3956c25bf348b538u, 0x59f111f1b605d019u, 0x923f82a4af194f9bu, 0xab1c5ed5da6d8118u,
    0xd807aa98a3030242u, 0x12835b0145706fbeu, 0x243185be4ee4b28cu, 0x550c7dc3d5ffb4e2u,
    0x72be5d74f27b896fu, 0x80deb1fe3b1696b1u, 0x9bdc06a725c71235u, 0xc19bf174cf692694u,
    0xe49b69c19ef14ad2u, 0xefbe4786384f25e3u, 0x0fc19dc68b8cd5b5u, 0x240ca1cc77ac9c65u,
    0x2de92c6f592b0275u, 0x4a7484aa6ea6e483u, 0x5cb0a9dcbd41fbd4u, 0x76f988da831153b5u,
    0x983e5152ee66dfabu, 0xa831c66d2db43210u, 0xb00327c898fb213fu, 0xbf597fc7beef0ee4u,
    0xc6e00bf33da88fc2u, 0xd5a79147930aa725u, 0x06ca6351e003826fu, 0x142929670a0e6e70u,
    0x27b70a8546d22ffcu, 0x2e1b21385c26c926u, 0x4d2c6dfc5ac42aedu, 0x53380d139d95b3dfu,
    0x650a73548baf63deu, 0x766a0abb3c77b2a8u, 0x81c2c92e47edaee6u, 0x92722c851482353bu,
    0xa2bfe8a14cf10364u, 0xa81a664bbc423001u, 0xc24b8b70d0f89791u, 0xc76c51a30654be30u,
    0xd192e819d6ef5218u, 0xd69906245565a910u, 0xf40e35855771202au, 0x106aa07032bbd1b8u,
    0x19a4c116b8d2d0c8u, 0x1e376c085141ab53u, 0x2748774cdf8eeb99u, 0x34b0bcb5e19b48a8u,
    0x391c0cb3c5c95a63u, 0x4ed8aa4ae3418acbu, 0x5b9cca4f7763e373u, 0x682e6ff3d6b2b8a3u,
    0x748f82ee5defb2fcu, 0x78a5636f43172f60u, 0x84c87814a1f0ab72u, 0x8cc702081a6439ecu,
    0x90befffa23631e28u, 0xa4506cebde82bde9u, 0xbef9a3f7b2c67915u, 0xc67178f2e372532bu,
    0xca273eceea26619cu, 0xd186b8c721c0c207u, 0xeada7dd6cde0eb1eu, 0xf57d4f7fee6ed178u,
    0x06f067aa72176fbau, 0x0a637dc5a2c898a6u, 0x113f9804bef90daeu, 0x1b710b35131c471bu,
    0x28db77f523047d84u, 0x32caab7b40c72493u, 0x3c9ebe0a15c9bebcu, 0x431d67c49c100d4cu,
    0x4cc5d4becb3e42b6u, 0x597f299cfc657e2au, 0x5fcb6fab3ad6faecu, 0x6c44198c4a475817u
);

// SHA-512 initial hash values
const H0: array<u64, 8> = array<u64, 8>(
    0x6a09e667f3bcc908u, 0xbb67ae8584caa73bu, 0x3c6ef372fe94f82bu, 0xa54ff53a5f1d36f1u,
    0x510e527fade682d1u, 0x9b05688c2b3e6c1fu, 0x1f83d9abfb41bd6bu, 0x5be0cd19137e2179u
);

struct Params {
    batch_size: u32,
    base_seed: u32,
    padding: vec2<u32>,
}

struct SeedHash {
    seed: array<u32, 8>,      // 32 bytes
    hash: array<u32, 16>,     // 64 bytes (SHA-512 output)
}

@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> outputs: array<SeedHash>;

// 64-bit rotate right
fn rotr64(x: u64, n: u32) -> u64 {
    return (x >> n) | (x << (64u - n));
}

// SHA-512 functions
fn ch64(x: u64, y: u64, z: u64) -> u64 {
    return (x & y) ^ (~x & z);
}

fn maj64(x: u64, y: u64, z: u64) -> u64 {
    return (x & y) ^ (x & z) ^ (y & z);
}

fn sigma0_512(x: u64) -> u64 {
    return rotr64(x, 28u) ^ rotr64(x, 34u) ^ rotr64(x, 39u);
}

fn sigma1_512(x: u64) -> u64 {
    return rotr64(x, 14u) ^ rotr64(x, 18u) ^ rotr64(x, 41u);
}

fn gamma0_512(x: u64) -> u64 {
    return rotr64(x, 1u) ^ rotr64(x, 8u) ^ (x >> 7u);
}

fn gamma1_512(x: u64) -> u64 {
    return rotr64(x, 19u) ^ rotr64(x, 61u) ^ (x >> 6u);
}

// Pack 8 u32s into 4 u64s (big-endian)
fn pack_u32_to_u64(data: array<u32, 8>) -> array<u64, 4> {
    var result: array<u64, 4>;
    for (var i = 0u; i < 4u; i++) {
        let high = u64(data[i * 2u]);
        let low = u64(data[i * 2u + 1u]);
        result[i] = (high << 32u) | low;
    }
    return result;
}

// Unpack 8 u64s into 16 u32s
fn unpack_u64_to_u32(data: array<u64, 8>) -> array<u32, 16> {
    var result: array<u32, 16>;
    for (var i = 0u; i < 8u; i++) {
        result[i * 2u] = u32(data[i] >> 32u);
        result[i * 2u + 1u] = u32(data[i] & 0xFFFFFFFFu);
    }
    return result;
}

// SHA-512 compression function
fn sha512_compress(state: ptr<function, array<u64, 8>>, block: array<u64, 16>) {
    var w: array<u64, 80>;

    // Prepare message schedule
    for (var i = 0u; i < 16u; i++) {
        w[i] = block[i];
    }
    for (var i = 16u; i < 80u; i++) {
        w[i] = gamma1_512(w[i - 2u]) + w[i - 7u] + gamma0_512(w[i - 15u]) + w[i - 16u];
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
        let t1 = h + sigma1_512(e) + ch64(e, f, g) + K[i] + w[i];
        let t2 = sigma0_512(a) + maj64(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    // Add compressed chunk to state
    (*state)[0] = (*state)[0] + a;
    (*state)[1] = (*state)[1] + b;
    (*state)[2] = (*state)[2] + c;
    (*state)[3] = (*state)[3] + d;
    (*state)[4] = (*state)[4] + e;
    (*state)[5] = (*state)[5] + f;
    (*state)[6] = (*state)[6] + g;
    (*state)[7] = (*state)[7] + h;
}

// Compute SHA-512 hash of 32-byte seed
fn compute_sha512(seed: array<u32, 8>) -> array<u64, 8> {
    var state = H0;

    // Prepare padded message (32 bytes + padding to 128 bytes)
    var block: array<u64, 16>;

    // First 4 u64s are the seed (32 bytes)
    let seed_u64 = pack_u32_to_u64(seed);
    for (var i = 0u; i < 4u; i++) {
        block[i] = seed_u64[i];
    }

    // Padding: append 0x80, then zeros, then length (256 bits = 32 bytes)
    block[4] = 0x8000000000000000u;  // 0x80 followed by zeros
    for (var i = 5u; i < 15u; i++) {
        block[i] = 0u;
    }
    block[15] = 256u;  // Length in bits

    // Compress
    sha512_compress(&state, block);

    return state;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let idx = global_id.x;

    if (idx >= params.batch_size) {
        return;
    }

    // Generate deterministic seed from index and base
    var seed: array<u32, 8>;
    let base_val = params.base_seed + idx;

    // Use simple PRNG to generate seed bytes
    var state = base_val;
    for (var i = 0u; i < 8u; i++) {
        // XORshift32
        state = state ^ (state << 13u);
        state = state ^ (state >> 17u);
        state = state ^ (state << 5u);
        seed[i] = state;
    }

    // Compute SHA-512 hash
    let hash_u64 = compute_sha512(seed);
    let hash_u32 = unpack_u64_to_u32(hash_u64);

    // Store results
    outputs[idx].seed = seed;
    outputs[idx].hash = hash_u32;
}
`;

/**
 * Hybrid WebGPU/CPU Key Generator
 * Uses GPU for SHA-512, CPU for Ed25519 scalar multiplication
 */
export class WebGPUHybridKeyGenerator {
    constructor() {
        this.device = null;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.isSupported = false;
        this.isInitialized = false;
        this.baseSeed = Math.floor(Math.random() * 0xFFFFFFFF);
    }

    /**
     * Check WebGPU support
     */
    static async isWebGPUSupported() {
        if (!navigator.gpu) {
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    /**
     * Initialize WebGPU
     */
    async initialize() {
        if (this.isInitialized) return true;

        try {
            this.isSupported = await WebGPUHybridKeyGenerator.isWebGPUSupported();
            if (!this.isSupported) {
                console.log('WebGPU not supported, using CPU fallback');
                return false;
            }

            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error('Failed to get GPU adapter');
            }

            this.device = await adapter.requestDevice();
            console.log('✓ WebGPU device initialized');

            await this.createPipeline();

            this.isInitialized = true;
            return true;

        } catch (error) {
            console.error('WebGPU initialization failed:', error);
            this.isSupported = false;
            return false;
        }
    }

    /**
     * Create compute pipeline
     */
    async createPipeline() {
        const shaderModule = this.device.createShaderModule({
            label: 'SHA-512 Compute Shader',
            code: sha512ComputeShader,
        });

        this.bindGroupLayout = this.device.createBindGroupLayout({
            label: 'SHA-512 Bind Group Layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'storage' }
                },
            ],
        });

        const pipelineLayout = this.device.createPipelineLayout({
            label: 'SHA-512 Pipeline Layout',
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.pipeline = this.device.createComputePipeline({
            label: 'SHA-512 Pipeline',
            layout: pipelineLayout,
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            },
        });

        console.log('✓ WebGPU compute pipeline created');
    }

    /**
     * Generate hashed seeds on GPU
     * Returns array of {seed, hash} objects for CPU to process
     */
    async generateHashedSeeds(batchSize) {
        if (!this.isInitialized) {
            throw new Error('WebGPU not initialized');
        }

        // Parameters buffer
        const params = new Uint32Array([
            batchSize,
            this.baseSeed,
            0, 0  // padding
        ]);
        this.baseSeed += batchSize;  // Increment for next batch

        const paramsBuffer = this.device.createBuffer({
            size: params.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Output buffer: (8 u32 seed + 16 u32 hash) * batchSize
        const outputSize = batchSize * (8 + 16) * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Write parameters
        this.device.queue.writeBuffer(paramsBuffer, 0, params);

        // Create bind group
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
            ],
        });

        // Encode and submit
        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(batchSize / 256));
        passEncoder.end();

        // Read back results
        const readBuffer = this.device.createBuffer({
            size: outputSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        commandEncoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, outputSize);
        this.device.queue.submit([commandEncoder.finish()]);

        // Map and read
        await readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint32Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();

        // Parse results
        const results = [];
        for (let i = 0; i < batchSize; i++) {
            const offset = i * 24;  // 8 + 16 u32s
            results.push({
                seed: Array.from(data.slice(offset, offset + 8)),
                hash: Array.from(data.slice(offset + 8, offset + 24)),
            });
        }

        // Cleanup
        paramsBuffer.destroy();
        outputBuffer.destroy();

        return results;
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this.device) {
            this.device.destroy();
        }
        this.isInitialized = false;
    }
}
