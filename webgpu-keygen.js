/**
 * WebGPU Ed25519 Key Generator
 * GPU-accelerated vanity key generation using WebGPU compute shaders
 */

export class WebGPUKeyGenerator {
    constructor() {
        this.device = null;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.isSupported = false;
        this.isInitialized = false;
        this.baseSeed = Math.floor(Math.random() * 0xFFFFFFFF);
        this.shaderCode = null;
    }

    /**
     * Check if WebGPU is supported
     */
    static async isSupported() {
        if (!navigator.gpu) {
            console.log('WebGPU not available in this browser');
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.log('No WebGPU adapter found');
                return false;
            }
            console.log('✓ WebGPU is supported');
            return true;
        } catch (error) {
            console.error('Error checking WebGPU support:', error);
            return false;
        }
    }

    /**
     * Load and concatenate shader files
     */
    async loadShaders() {
        try {
            // Load i256.wgsl (256-bit integer library)
            const i256Response = await fetch('./i256.wgsl');
            const i256Code = await i256Response.text();

            // Load ed25519-curve.wgsl (elliptic curve operations)
            const curveResponse = await fetch('./ed25519-curve.wgsl');
            const curveCode = await curveResponse.text();

            // Load ed25519-gpu.wgsl (main shader with SHA-512 and main kernel)
            const mainResponse = await fetch('./ed25519-gpu.wgsl');
            const mainCode = await mainResponse.text();

            // Combine shaders in correct order:
            // 1. i256 (provides 256-bit arithmetic)
            // 2. curve operations (uses i256)
            // 3. main shader (uses curve operations)
            this.shaderCode = i256Code + '\n\n' + curveCode + '\n\n' + mainCode;

            console.log('✓ Shaders loaded successfully');
            console.log(`  i256.wgsl: ${i256Code.length} bytes`);
            console.log(`  ed25519-curve.wgsl: ${curveCode.length} bytes`);
            console.log(`  ed25519-gpu.wgsl: ${mainCode.length} bytes`);
            console.log(`  Total shader size: ${this.shaderCode.length.toLocaleString()} bytes`);

            return true;
        } catch (error) {
            console.error('Failed to load shaders:', error);
            return false;
        }
    }

    /**
     * Initialize WebGPU device and pipeline
     */
    async initialize() {
        if (this.isInitialized) {
            return true;
        }

        try {
            // Check support
            this.isSupported = await WebGPUKeyGenerator.isSupported();
            if (!this.isSupported) {
                return false;
            }

            // Request adapter
            const adapter = await navigator.gpu.requestAdapter({
                powerPreference: 'high-performance'
            });

            if (!adapter) {
                throw new Error('Failed to get GPU adapter');
            }

            // Log adapter info
            console.log('GPU Adapter:', adapter);

            // Request device with required features
            this.device = await adapter.requestDevice({
                requiredLimits: {
                    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                    maxComputeWorkgroupSizeX: 256,
                }
            });

            console.log('✓ WebGPU device acquired');
            console.log('  Device limits:', this.device.limits);

            // Load shaders
            const shadersLoaded = await this.loadShaders();
            if (!shadersLoaded) {
                throw new Error('Failed to load shaders');
            }

            // Create pipeline
            await this.createPipeline();

            this.isInitialized = true;
            console.log('✓ WebGPU key generator initialized successfully');

            return true;

        } catch (error) {
            console.error('Failed to initialize WebGPU:', error);
            this.isSupported = false;
            return false;
        }
    }

    /**
     * Create the compute pipeline
     */
    async createPipeline() {
        try {
            // Create shader module
            const shaderModule = this.device.createShaderModule({
                label: 'Ed25519 Key Generation Shader',
                code: this.shaderCode,
            });

            // Check for shader compilation errors
            const compilationInfo = await shaderModule.getCompilationInfo();
            if (compilationInfo.messages.length > 0) {
                let hasErrors = false;
                console.log('Shader compilation messages:');
                for (const message of compilationInfo.messages) {
                    const level = message.type === 'error' ? 'ERROR' : message.type === 'warning' ? 'WARN' : 'INFO';
                    console.log(`  [${level}] Line ${message.lineNum}: ${message.message}`);
                    if (message.type === 'error') {
                        hasErrors = true;
                    }
                }

                if (hasErrors) {
                    throw new Error(`Shader compilation failed with ${compilationInfo.messages.filter(m => m.type === 'error').length} errors. Check console for details.`);
                }
            } else {
                console.log('✓ Shader compiled successfully with no warnings or errors');
            }

            // Create bind group layout
            this.bindGroupLayout = this.device.createBindGroupLayout({
                label: 'Key Generation Bind Group Layout',
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'read-only-storage' }
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'read-only-storage' }
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' }
                    },
                    {
                        binding: 3,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' }
                    },
                ],
            });

            // Create pipeline layout
            const pipelineLayout = this.device.createPipelineLayout({
                label: 'Key Generation Pipeline Layout',
                bindGroupLayouts: [this.bindGroupLayout],
            });

            // Create compute pipeline
            this.pipeline = this.device.createComputePipeline({
                label: 'Key Generation Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            console.log('✓ Compute pipeline created');

        } catch (error) {
            console.error('Failed to create pipeline:', error);
            throw error;
        }
    }

    /**
     * Convert hex prefix string to u32 array
     */
    hexPrefixToU32Array(prefix) {
        const result = new Uint32Array(8);

        for (let i = 0; i < Math.min(prefix.length, 64); i += 2) {
            const hexByte = prefix.substr(i, 2).padEnd(2, '0');
            const byteVal = parseInt(hexByte, 16) || 0;

            const u32Idx = Math.floor(i / 8);
            const byteIdx = Math.floor((i % 8) / 2);
            const shift = (3 - byteIdx) * 8;

            result[u32Idx] |= (byteVal << shift);
        }

        return result;
    }

    /**
     * Generate a batch of keys on GPU
     * @param {number} batchSize - Number of keys to generate
     * @param {string} targetPrefix - Hex prefix to match
     * @returns {Promise<Array>} - Array of matching keypairs
     */
    async generateBatch(batchSize, targetPrefix) {
        if (!this.isInitialized) {
            throw new Error('WebGPU not initialized');
        }

        const startTime = performance.now();

        // Prepare parameters
        const params = new Uint32Array([
            batchSize,
            targetPrefix.length,
            this.baseSeed,
            0  // padding
        ]);
        this.baseSeed += batchSize;  // Increment for next batch

        // Convert target prefix
        const prefixArray = this.hexPrefixToU32Array(targetPrefix);

        // Create buffers
        const paramsBuffer = this.device.createBuffer({
            size: params.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        const prefixBuffer = this.device.createBuffer({
            size: prefixArray.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Results buffer: max 1024 matches per batch
        const maxResults = 1024;
        const resultSize = maxResults * 128;  // 128 bytes per result
        const resultsBuffer = this.device.createBuffer({
            size: resultSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        const matchCountBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        // Write data
        this.device.queue.writeBuffer(paramsBuffer, 0, params);
        this.device.queue.writeBuffer(prefixBuffer, 0, prefixArray);

        // Create bind group
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: prefixBuffer } },
                { binding: 2, resource: { buffer: resultsBuffer } },
                { binding: 3, resource: { buffer: matchCountBuffer } },
            ],
        });

        // Create command encoder
        const commandEncoder = this.device.createCommandEncoder();

        // Dispatch compute shader
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(batchSize / 256));
        passEncoder.end();

        // Read back match count
        const matchCountReadBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        commandEncoder.copyBufferToBuffer(
            matchCountBuffer, 0,
            matchCountReadBuffer, 0,
            4
        );

        // Submit commands
        this.device.queue.submit([commandEncoder.finish()]);

        // Wait for completion and read match count
        await matchCountReadBuffer.mapAsync(GPUMapMode.READ);
        const matchCountData = new Uint32Array(matchCountReadBuffer.getMappedRange());
        const matchCount = matchCountData[0];
        matchCountReadBuffer.unmap();

        const gpuTime = performance.now() - startTime;

        // If matches found, read results
        const results = [];
        if (matchCount > 0) {
            const actualMatches = Math.min(matchCount, maxResults);

            const resultsReadBuffer = this.device.createBuffer({
                size: actualMatches * 128,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            const readEncoder = this.device.createCommandEncoder();
            readEncoder.copyBufferToBuffer(
                resultsBuffer, 0,
                resultsReadBuffer, 0,
                actualMatches * 128
            );
            this.device.queue.submit([readEncoder.finish()]);

            await resultsReadBuffer.mapAsync(GPUMapMode.READ);
            const resultsData = new Uint32Array(resultsReadBuffer.getMappedRange());

            // Parse results
            for (let i = 0; i < actualMatches; i++) {
                const offset = i * 32;  // 32 u32s per result

                const found = resultsData[offset];
                if (found === 0) continue;

                const publicKey = Array.from(resultsData.slice(offset + 1, offset + 9));
                const privateKey = Array.from(resultsData.slice(offset + 9, offset + 25));
                const seed = Array.from(resultsData.slice(offset + 25, offset + 33));

                // Convert to hex strings
                const pubKeyHex = publicKey.map(v => v.toString(16).padStart(8, '0')).join('');
                const privKeyHex = privateKey.map(v => v.toString(16).padStart(8, '0')).join('');

                results.push({
                    publicKey: pubKeyHex,
                    privateKey: privKeyHex,
                    seed: seed,
                });
            }

            resultsReadBuffer.unmap();
        }

        // Cleanup
        paramsBuffer.destroy();
        prefixBuffer.destroy();
        resultsBuffer.destroy();
        matchCountBuffer.destroy();

        return {
            results,
            matchCount,
            batchSize,
            gpuTime,
            keysPerSecond: batchSize / (gpuTime / 1000),
        };
    }

    /**
     * Cleanup resources
     */
    destroy() {
        if (this.device) {
            this.device.destroy();
            this.device = null;
        }
        this.isInitialized = false;
        console.log('WebGPU resources cleaned up');
    }
}
