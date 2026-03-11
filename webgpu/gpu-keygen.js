// ============================================================
// gpu-keygen.js — WebGPU pipeline manager for Ed25519 vanity keygen
// Manages device, shader compilation, buffers, and dispatch
// ============================================================

import { getBaseTableBuffer } from './precompute.js';

export class GPUKeyGenerator {
    constructor() {
        this.device = null;
        this.pipeline = null;
        this.bindGroup = null;
        this.configBuffer = null;
        this.baseTableBuffer = null;
        this.matchBuffer = null;
        this.matchCountBuffer = null;
        this.readbackBuffer = null;
        this.readbackCountBuffer = null;
        this.dispatchId = 0;
        this.workgroupSize = 64;
        this.numWorkgroups = 1024;
        this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
        this.isReady = false;
    }

    static async isAvailable() {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    async initialize() {
        if (this.isReady) return;

        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance'
        });
        if (!adapter) throw new Error('No WebGPU adapter found');

        this.device = await adapter.requestDevice({
            requiredLimits: {
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize,
            }
        });

        // Listen for device errors
        this.device.lost.then(info => console.error('GPU device lost:', info.message, info.reason));
        this.device.addEventListener('uncapturederror', event => {
            console.error('GPU uncaptured error:', event.error.message);
        });

        // Load and compile WGSL shader (cache-bust to avoid stale files)
        const shaderUrl = new URL(`./ed25519.wgsl?v=${Date.now()}`, import.meta.url);
        const shaderCode = await (await fetch(shaderUrl)).text();
        console.log(`WGSL shader loaded: ${shaderCode.length} chars, first 80: "${shaderCode.substring(0, 80)}"`);
        const shaderModule = this.device.createShaderModule({ code: shaderCode });

        // Check for compilation errors
        const info = await shaderModule.getCompilationInfo();
        for (const msg of info.messages) {
            if (msg.type === 'error') {
                console.error('WGSL compilation error:', msg.message, `line ${msg.lineNum}`);
                throw new Error(`Shader compilation failed: ${msg.message}`);
            }
            if (msg.type === 'warning') {
                console.warn('WGSL warning:', msg.message);
            }
        }

        // Create buffers
        // Config buffer (uniform): prefix + dispatch seed
        this.configBuffer = this.device.createBuffer({
            size: 32, // 8 × u32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Base point table (storage, read-only): 16 points × 4 coords × 16 limbs
        const tableData = getBaseTableBuffer();
        this.baseTableBuffer = this.device.createBuffer({
            size: tableData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(this.baseTableBuffer, 0, tableData);

        // Match output buffer: 64 matches × (8+8) u32 = 64 × 64 bytes
        const matchBufferSize = 64 * 16 * 4; // 64 matches × 16 u32 each × 4 bytes
        this.matchBuffer = this.device.createBuffer({
            size: matchBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Match count buffer: single atomic<u32>
        this.matchCountBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        // Readback buffers (for async CPU read)
        this.readbackBuffer = this.device.createBuffer({
            size: matchBufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this.readbackCountBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        // Create bind group layout and pipeline
        const bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ]
        });

        this.pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            compute: { module: shaderModule, entryPoint: 'main' },
        });

        this.bindGroup = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.configBuffer } },
                { binding: 1, resource: { buffer: this.baseTableBuffer } },
                { binding: 2, resource: { buffer: this.matchBuffer } },
                { binding: 3, resource: { buffer: this.matchCountBuffer } },
            ]
        });

        this.isReady = true;
        console.log(`✓ WebGPU initialized: ${this.threadsPerDispatch} threads/dispatch`);
    }

    // Parse hex prefix string into config buffer format
    _encodePrefix(targetPrefix) {
        const nibbles = targetPrefix.length;
        const bytes = new Uint8Array(8);
        for (let i = 0; i < nibbles; i++) {
            const nibble = parseInt(targetPrefix[i], 16);
            if (i & 1) {
                bytes[i >>> 1] |= nibble;
            } else {
                bytes[i >>> 1] = nibble << 4;
            }
        }
        // Pack into 2 × u32 (little-endian)
        const view = new DataView(bytes.buffer);
        return {
            prefix0: view.getUint32(0, true),
            prefix1: view.getUint32(4, true),
            nibbles: nibbles,
        };
    }

    // Dispatch one batch of GPU key generation
    // Returns: { matches: [{seed, pubkey}], attempted: number }
    async dispatchBatch(targetPrefix) {
        if (!this.isReady) throw new Error('GPU not initialized');

        const prefixConfig = this._encodePrefix(targetPrefix);

        // Generate random dispatch seed
        const seed = crypto.getRandomValues(new Uint32Array(4));

        // Write config buffer
        const configData = new Uint32Array(8);
        configData[0] = prefixConfig.prefix0;
        configData[1] = prefixConfig.prefix1;
        configData[2] = prefixConfig.nibbles;
        configData[3] = seed[0];
        configData[4] = seed[1];
        configData[5] = seed[2];
        configData[6] = seed[3];
        configData[7] = this.dispatchId++;
        this.device.queue.writeBuffer(this.configBuffer, 0, configData);

        // Reset match counter
        this.device.queue.writeBuffer(this.matchCountBuffer, 0, new Uint32Array([0]));

        // Push error scope to catch validation/OOM errors during dispatch
        this.device.pushErrorScope('validation');
        this.device.pushErrorScope('out-of-memory');

        // Encode and submit compute pass
        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup);
        passEncoder.dispatchWorkgroups(this.numWorkgroups);
        passEncoder.end();

        // Copy results to readback buffers
        commandEncoder.copyBufferToBuffer(this.matchCountBuffer, 0, this.readbackCountBuffer, 0, 4);
        commandEncoder.copyBufferToBuffer(this.matchBuffer, 0, this.readbackBuffer, 0, this.readbackBuffer.size);

        this.device.queue.submit([commandEncoder.finish()]);

        // Check for GPU errors
        const oomError = await this.device.popErrorScope();
        const valError = await this.device.popErrorScope();
        if (oomError) console.error('GPU OOM error:', oomError.message);
        if (valError) console.error('GPU validation error:', valError.message);

        // Async readback
        await this.readbackCountBuffer.mapAsync(GPUMapMode.READ);
        const countData = new Uint32Array(this.readbackCountBuffer.getMappedRange());
        const rawCount = countData[0];
        const matchCount = Math.min(rawCount, 64);
        this.readbackCountBuffer.unmap();
        console.log(`GPU dispatch ${this.dispatchId - 1}: raw match_count=${rawCount}, used=${matchCount}, workgroups=${this.numWorkgroups}`);

        const matches = [];
        if (matchCount > 0) {
            await this.readbackBuffer.mapAsync(GPUMapMode.READ);
            const matchData = new Uint32Array(this.readbackBuffer.getMappedRange());

            for (let i = 0; i < matchCount; i++) {
                const offset = i * 16; // 16 u32 per match (8 seed + 8 pubkey)
                const seed = new Uint32Array(8);
                const pubkey = new Uint32Array(8);
                for (let j = 0; j < 8; j++) {
                    seed[j] = matchData[offset + j];
                    pubkey[j] = matchData[offset + 8 + j];
                }
                matches.push({
                    seed: new Uint8Array(seed.buffer),
                    pubkey: new Uint8Array(pubkey.buffer),
                });
            }

            this.readbackBuffer.unmap();
        }

        return {
            matches,
            attempted: this.threadsPerDispatch,
        };
    }

    destroy() {
        if (this.configBuffer) this.configBuffer.destroy();
        if (this.baseTableBuffer) this.baseTableBuffer.destroy();
        if (this.matchBuffer) this.matchBuffer.destroy();
        if (this.matchCountBuffer) this.matchCountBuffer.destroy();
        if (this.readbackBuffer) this.readbackBuffer.destroy();
        if (this.readbackCountBuffer) this.readbackCountBuffer.destroy();
        if (this.device) this.device.destroy();
        this.isReady = false;
    }
}
