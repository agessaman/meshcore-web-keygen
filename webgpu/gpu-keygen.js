// ============================================================
// gpu-keygen.js — WebGPU pipeline manager for Ed25519 vanity keygen
// Manages device, shader compilation, buffers, and dispatch
// ============================================================

import { getBaseTableBuffer } from './precompute.js';

const MAX_WORKGROUPS_PER_SUBMIT = 64;
const DISPATCHES_PER_SUBMIT = 4; // when chunking at 64, pack this many dispatches per submit to reduce round-trips

export class GPUKeyGenerator {
    constructor() {
        this.device = null;
        this.pipeline = null;
        this.bindGroup = null;
        this.bindGroup1 = null;
        this.bindGroup2 = null;
        this.bindGroup3 = null;
        this.configBuffer = null;
        this.configBuffer1 = null;
        this.configBuffer2 = null;
        this.configBuffer3 = null;
        this.baseTableBuffer = null;
        this.matchBuffer = null;
        this.matchCountBuffer = null;
        this.readbackBuffer = null;
        this.readbackCountBuffer = null;
        this.dispatchId = 0;
        this.workgroupSize = 64;
        this.numWorkgroups = 1024;
        this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
        this.consecutiveZeroCompletions = 0;
        this.consecutiveFullCompletions = 0;
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
        // Config buffer (uniform): prefix + dispatch seed + base_thread_id (9 × u32 = 36 bytes)
        const configSize = 36;
        this.configBuffer = this.device.createBuffer({
            size: configSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.configBuffer1 = this.device.createBuffer({
            size: configSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.configBuffer2 = this.device.createBuffer({
            size: configSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.configBuffer3 = this.device.createBuffer({
            size: configSize,
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

        // Match count buffer: match_count + completed_count (2 × atomic<u32> = 8 bytes)
        this.matchCountBuffer = this.device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        // Readback buffers (for async CPU read)
        this.readbackBuffer = this.device.createBuffer({
            size: matchBufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        this.readbackCountBuffer = this.device.createBuffer({
            size: 8,
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
        this.bindGroup1 = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.configBuffer1 } },
                { binding: 1, resource: { buffer: this.baseTableBuffer } },
                { binding: 2, resource: { buffer: this.matchBuffer } },
                { binding: 3, resource: { buffer: this.matchCountBuffer } },
            ]
        });
        this.bindGroup2 = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.configBuffer2 } },
                { binding: 1, resource: { buffer: this.baseTableBuffer } },
                { binding: 2, resource: { buffer: this.matchBuffer } },
                { binding: 3, resource: { buffer: this.matchCountBuffer } },
            ]
        });
        this.bindGroup3 = this.device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.configBuffer3 } },
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
    // options.allowWorkgroupReduce: if true (default), reduce workgroups on completed=0; set false during validation probe
    async dispatchBatch(targetPrefix, options = {}) {
        if (!this.isReady) throw new Error('GPU not initialized');

        const allowReduce = options.allowWorkgroupReduce !== false;
        let totalAttempted = 0;
        const allMatches = [];

        if (this.numWorkgroups <= MAX_WORKGROUPS_PER_SUBMIT) {
            const runs = this.numWorkgroups <= 128 ? 4 : (this.numWorkgroups <= 256 ? 2 : 1);
            for (let run = 0; run < runs; run++) {
                const result = await this._dispatchOnce(targetPrefix, allowReduce, null);
                totalAttempted += result.attempted;
                for (const m of result.matches) allMatches.push(m);
                if (allMatches.length >= 64) break;
            }
        } else {
            for (let offset = 0; offset < this.numWorkgroups; offset += MAX_WORKGROUPS_PER_SUBMIT * DISPATCHES_PER_SUBMIT) {
                const chunkSize = Math.min(MAX_WORKGROUPS_PER_SUBMIT * DISPATCHES_PER_SUBMIT, this.numWorkgroups - offset);
                const result = await this._dispatchOnce(targetPrefix, false, MAX_WORKGROUPS_PER_SUBMIT, Math.min(DISPATCHES_PER_SUBMIT, Math.ceil(chunkSize / MAX_WORKGROUPS_PER_SUBMIT)));
                totalAttempted += result.attempted;
                for (const m of result.matches) allMatches.push(m);
                if (allMatches.length >= 64) break;
            }
            if (allowReduce) {
                const expected = this.numWorkgroups * this.workgroupSize;
                if (totalAttempted === 0) {
                    this.consecutiveZeroCompletions++;
                    this.consecutiveFullCompletions = 0;
                    if (this.consecutiveZeroCompletions >= 2 && this.numWorkgroups > 4) {
                        this.numWorkgroups = Math.max(4, Math.floor(this.numWorkgroups * 0.8));
                        this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
                        this.consecutiveZeroCompletions = 0;
                        console.warn(`WebGPU: repeated batch failures; reducing to ${this.numWorkgroups} workgroups`);
                    }
                } else {
                    this.consecutiveZeroCompletions = 0;
                    if (expected > 0 && totalAttempted >= Math.floor(0.95 * expected)) {
                        this.consecutiveFullCompletions++;
                        if (this.consecutiveFullCompletions >= 5 && this.numWorkgroups < 1024) {
                            const next = Math.min(1024, Math.ceil(this.numWorkgroups * 1.1));
                            if (next > this.numWorkgroups) {
                                this.numWorkgroups = next;
                                this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
                                this.consecutiveFullCompletions = 0;
                                console.log(`WebGPU: stable completions; trying ${this.numWorkgroups} workgroups`);
                            }
                        }
                    } else {
                        this.consecutiveFullCompletions = 0;
                    }
                }
            }
        }

        return {
            matches: allMatches.slice(0, 64),
            attempted: totalAttempted,
        };
    }

    // Single GPU dispatch (used by dispatchBatch and validation)
    // workgroupsOverride: if set, dispatch this many workgroups and do not run adaptive logic
    // dispatchesPerSubmit: when chunking at MAX_WORKGROUPS_PER_SUBMIT, pack this many dispatches in one submit (each with different base_thread_id)
    async _dispatchOnce(targetPrefix, allowWorkgroupReduce = true, workgroupsOverride = null, dispatchesPerSubmit = 1) {
        const prefixConfig = this._encodePrefix(targetPrefix);
        const workgroupsToUse = workgroupsOverride !== null ? workgroupsOverride : this.numWorkgroups;

        // Generate random dispatch seed
        const seed = crypto.getRandomValues(new Uint32Array(4));

        const configSize = 36; // 9 × u32
        const writeConfig = (buffer, baseThreadId) => {
            const configData = new Uint32Array(9);
            configData[0] = prefixConfig.prefix0;
            configData[1] = prefixConfig.prefix1;
            configData[2] = prefixConfig.nibbles;
            configData[3] = seed[0];
            configData[4] = seed[1];
            configData[5] = seed[2];
            configData[6] = seed[3];
            configData[7] = this.dispatchId;
            configData[8] = baseThreadId;
            this.device.queue.writeBuffer(buffer, 0, configData);
        };

        this.dispatchId += dispatchesPerSubmit;

        // Reset both count atomics (match_count, completed_count)
        this.device.queue.writeBuffer(this.matchCountBuffer, 0, new Uint32Array([0, 0]));

        // Push error scope to catch validation/OOM errors during dispatch
        this.device.pushErrorScope('validation');
        this.device.pushErrorScope('out-of-memory');

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.pipeline);

        const multiDispatch = dispatchesPerSubmit > 1 && workgroupsToUse === MAX_WORKGROUPS_PER_SUBMIT;
        if (multiDispatch) {
            const configBuffers = [this.configBuffer, this.configBuffer1, this.configBuffer2, this.configBuffer3];
            const bindGroups = [this.bindGroup, this.bindGroup1, this.bindGroup2, this.bindGroup3];
            for (let i = 0; i < dispatchesPerSubmit; i++) {
                const base = i * MAX_WORKGROUPS_PER_SUBMIT * this.workgroupSize;
                writeConfig(configBuffers[i], base);
            }
            for (let i = 0; i < dispatchesPerSubmit; i++) {
                passEncoder.setBindGroup(0, bindGroups[i]);
                passEncoder.dispatchWorkgroups(MAX_WORKGROUPS_PER_SUBMIT);
            }
        } else {
            writeConfig(this.configBuffer, 0);
            passEncoder.setBindGroup(0, this.bindGroup);
            passEncoder.dispatchWorkgroups(workgroupsToUse);
        }

        passEncoder.end();

        // Copy results to readback buffers (8 bytes: match_count, completed_count)
        commandEncoder.copyBufferToBuffer(this.matchCountBuffer, 0, this.readbackCountBuffer, 0, 8);
        commandEncoder.copyBufferToBuffer(this.matchBuffer, 0, this.readbackBuffer, 0, this.readbackBuffer.size);

        const t0 = performance.now();
        this.device.queue.submit([commandEncoder.finish()]);

        // Check for GPU errors
        const oomError = await this.device.popErrorScope();
        const valError = await this.device.popErrorScope();
        if (oomError) console.error('GPU OOM error:', oomError.message);
        if (valError) console.error('GPU validation error:', valError.message);

        // Async readback (countData[0]=match_count, countData[1]=completed_count)
        await this.readbackCountBuffer.mapAsync(GPUMapMode.READ);
        const countData = new Uint32Array(this.readbackCountBuffer.getMappedRange());
        const rawMatchCount = countData[0];
        const matchCount = Math.min(rawMatchCount, 64);
        const completedCount = countData[1];
        this.readbackCountBuffer.unmap();
        const elapsed = performance.now() - t0;
        if (completedCount === 0) {
            console.warn(`WebGPU: batch completed 0 threads in ${elapsed.toFixed(0)}ms (possible TDR or device loss; TDR often ~2–5s, but can be much lower)`);
        }
        console.log(`GPU dispatch ${this.dispatchId - 1}: match_count=${rawMatchCount}, completed=${completedCount}, workgroups=${workgroupsToUse * (multiDispatch ? dispatchesPerSubmit : 1)}`);

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

        // Adapt workgroup count only when allowWorkgroupReduce and not using override (not during validation or chunked dispatch)
        if (allowWorkgroupReduce && workgroupsOverride === null) {
            const expected = this.workgroupSize * this.numWorkgroups;
            if (completedCount === 0) {
                this.consecutiveZeroCompletions++;
                this.consecutiveFullCompletions = 0;
                // Only reduce after 2 consecutive failures, and step down by 20% to avoid spiraling to 50
                if (this.consecutiveZeroCompletions >= 2 && this.numWorkgroups > 4) {
                    this.numWorkgroups = Math.max(4, Math.floor(this.numWorkgroups * 0.8));
                    this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
                    this.consecutiveZeroCompletions = 0;
                    console.warn(`WebGPU: repeated batch failures; reducing to ${this.numWorkgroups} workgroups`);
                }
            } else {
                this.consecutiveZeroCompletions = 0;
                if (expected > 0 && completedCount >= Math.floor(0.95 * expected)) {
                    this.consecutiveFullCompletions++;
                    // After 5 sustained full completions, try increasing workgroups (cap 1024)
                    if (this.consecutiveFullCompletions >= 5 && this.numWorkgroups < 1024) {
                        const next = Math.min(1024, Math.ceil(this.numWorkgroups * 1.1));
                        if (next > this.numWorkgroups) {
                            this.numWorkgroups = next;
                            this.threadsPerDispatch = this.workgroupSize * this.numWorkgroups;
                            this.consecutiveFullCompletions = 0;
                            console.log(`WebGPU: stable completions; trying ${this.numWorkgroups} workgroups`);
                        }
                    }
                } else {
                    this.consecutiveFullCompletions = 0;
                }
            }
        }

        return {
            matches,
            attempted: completedCount,
        };
    }

    destroy() {
        if (this.configBuffer) this.configBuffer.destroy();
        if (this.configBuffer1) this.configBuffer1.destroy();
        if (this.configBuffer2) this.configBuffer2.destroy();
        if (this.configBuffer3) this.configBuffer3.destroy();
        if (this.baseTableBuffer) this.baseTableBuffer.destroy();
        if (this.matchBuffer) this.matchBuffer.destroy();
        if (this.matchCountBuffer) this.matchCountBuffer.destroy();
        if (this.readbackBuffer) this.readbackBuffer.destroy();
        if (this.readbackCountBuffer) this.readbackCountBuffer.destroy();
        if (this.device) this.device.destroy();
        this.isReady = false;
    }
}
