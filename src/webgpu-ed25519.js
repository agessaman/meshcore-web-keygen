import { PRECOMP_WORDS } from './webgpu-ed25519-table.js';

const WORKGROUP_SIZE = 64;

const shaderSource = /* wgsl */ `
struct Scalars {
  words: array<u32>,
}

struct Table {
  words: array<u32>,
}

struct Params {
  batchSize: u32,
  prefixNibbleLength: u32,
  prefix0: u32,
  prefix1: u32,
  prefix2: u32,
  prefix3: u32,
}

struct Flags {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read> scalars: Scalars;
@group(0) @binding(1) var<storage, read> tableData: Table;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> flags: Flags;

const LIMBS: u32 = 16u;
const WORDS_PER_POINT: u32 = 48u;
const WINDOW_COUNT: u32 = 64u;
const FE_P: array<u32, 16> = array<u32, 16>(
  65517u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u,
  65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 32767u
);
const FE_TWO_P: array<u32, 16> = array<u32, 16>(
  65498u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u,
  65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u, 65535u
);

struct Point {
  X: array<u32, 16>,
  Y: array<u32, 16>,
  Z: array<u32, 16>,
  T: array<u32, 16>,
}

fn fe_zero() -> array<u32, 16> {
  var out: array<u32, 16>;
  return out;
}

fn fe_one() -> array<u32, 16> {
  var out: array<u32, 16>;
  out[0] = 1u;
  return out;
}

fn fe_finalize(input: array<u32, 16>) -> array<u32, 16> {
  var out = input;

  for (var round: u32 = 0u; round < 3u; round = round + 1u) {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < 16u; i = i + 1u) {
      let total = out[i] + carry;
      out[i] = total & 65535u;
      carry = total >> 16u;
    }
    out[0] = out[0] + carry * 38u;

    carry = 0u;
    for (var i: u32 = 0u; i < 15u; i = i + 1u) {
      let total = out[i] + carry;
      out[i] = total & 65535u;
      carry = total >> 16u;
    }
    let total15 = out[15] + carry;
    out[15] = total15 & 65535u;
    carry = total15 >> 16u;
    out[0] = out[0] + carry * 38u;

    let extra = out[15] >> 15u;
    out[15] = out[15] & 32767u;
    out[0] = out[0] + extra * 19u;
  }

  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < 15u; i = i + 1u) {
    let total = out[i] + carry;
    out[i] = total & 65535u;
    carry = total >> 16u;
  }
  out[15] = out[15] + carry;
  let extra = out[15] >> 15u;
  out[15] = out[15] & 32767u;
  out[0] = out[0] + extra * 19u;

  carry = 0u;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    let total = out[i] + carry;
    out[i] = total & 65535u;
    carry = total >> 16u;
  }
  out[0] = out[0] + carry * 38u;

  var ge = true;
  for (var idx: i32 = 15; idx >= 0; idx = idx - 1) {
    let value = out[u32(idx)];
    let modulus = FE_P[u32(idx)];
    if (value > modulus) {
      ge = true;
      break;
    }
    if (value < modulus) {
      ge = false;
      break;
    }
  }

  if (ge) {
    var borrow: i32 = 0;
    for (var i: u32 = 0u; i < 16u; i = i + 1u) {
      let diff = i32(out[i]) - i32(FE_P[i]) - borrow;
      if (diff < 0) {
        out[i] = u32(diff + 65536);
        borrow = 1;
      } else {
        out[i] = u32(diff);
        borrow = 0;
      }
    }
  }

  return out;
}

fn fe_add(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var out: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    out[i] = a[i] + b[i];
  }
  return fe_finalize(out);
}

fn fe_sub(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var out: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    out[i] = a[i] + FE_TWO_P[i] - b[i];
  }
  return fe_finalize(out);
}

fn fe_mul(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
  var accLow: array<u32, 32>;
  var accHigh: array<u32, 32>;

  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    for (var j: u32 = 0u; j < 16u; j = j + 1u) {
      let idx = i + j;
      let product = a[i] * b[j];
      let next = accLow[idx] + product;
      if (next < accLow[idx]) {
        accHigh[idx] = accHigh[idx] + 1u;
      }
      accLow[idx] = next;
    }
  }

  var limbs: array<u32, 32>;
  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    var high = accHigh[i];
    let total = accLow[i] + carry;
    if (total < carry) {
      high = high + 1u;
    }
    limbs[i] = total & 65535u;
    carry = (total >> 16u) + (high << 16u);
  }

  for (var i: u32 = 16u; i < 32u; i = i + 1u) {
    limbs[i - 16u] = limbs[i - 16u] + limbs[i] * 38u;
  }

  var out: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    out[i] = limbs[i];
  }
  return fe_finalize(out);
}

fn fe_square(a: array<u32, 16>) -> array<u32, 16> {
  return fe_mul(a, a);
}

fn fe_pow_p_minus_2(z: array<u32, 16>) -> array<u32, 16> {
  var result = fe_one();
  for (var bit: i32 = 254; bit >= 0; bit = bit - 1) {
    result = fe_square(result);
    if (bit != 2 && bit != 4) {
      result = fe_mul(result, z);
    }
  }
  return result;
}

fn point_identity() -> Point {
  var p: Point;
  p.X = fe_zero();
  p.Y = fe_one();
  p.Z = fe_one();
  p.T = fe_zero();
  return p;
}

fn load_coord(base: u32) -> array<u32, 16> {
  var out: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) {
    out[i] = tableData.words[base + i];
  }
  return out;
}

fn point_add_precomp(p: Point, window: u32, digit: u32) -> Point {
  if (digit == 0u) {
    return p;
  }

  let pointIndex = window * 15u + (digit - 1u);
  let base = pointIndex * WORDS_PER_POINT;
  let yPlusX = load_coord(base);
  let yMinusX = load_coord(base + 16u);
  let xy2d = load_coord(base + 32u);

  let ySubX = fe_sub(p.Y, p.X);
  let yAddX = fe_add(p.Y, p.X);
  let a = fe_mul(ySubX, yMinusX);
  let b = fe_mul(yAddX, yPlusX);
  let c = fe_mul(p.T, xy2d);
  let d = fe_add(p.Z, p.Z);
  let e = fe_sub(b, a);
  let f = fe_sub(d, c);
  let g = fe_add(d, c);
  let h = fe_add(b, a);

  var out: Point;
  out.X = fe_mul(e, f);
  out.Y = fe_mul(g, h);
  out.Z = fe_mul(f, g);
  out.T = fe_mul(e, h);
  return out;
}

fn scalar_digit(candidateIndex: u32, window: u32) -> u32 {
  let wordIndex = candidateIndex * 8u + (window / 8u);
  let word = scalars.words[wordIndex];
  let shift = (window % 8u) * 4u;
  return (word >> shift) & 15u;
}

fn prefix_byte(slot: u32) -> u32 {
  switch slot {
    case 0u: { return params.prefix0; }
    case 1u: { return params.prefix1; }
    case 2u: { return params.prefix2; }
    default: { return params.prefix3; }
  }
}

fn matches_prefix(y: array<u32, 16>) -> bool {
  if (params.prefixNibbleLength == 0u) {
    return false;
  }

  let firstByte = y[0] & 255u;
  if (firstByte == 0u || firstByte == 255u) {
    return false;
  }

  let fullBytes = params.prefixNibbleLength / 2u;
  let hasHalfByte = (params.prefixNibbleLength & 1u) == 1u;

  for (var i: u32 = 0u; i < fullBytes; i = i + 1u) {
    let limb = y[i / 2u];
    let actual = select((limb >> 8u) & 255u, limb & 255u, (i & 1u) == 0u);
    if (actual != prefix_byte(i)) {
      return false;
    }
  }

  if (hasHalfByte) {
    let index = fullBytes;
    let limb = y[index / 2u];
    let actual = select((limb >> 8u) & 255u, limb & 255u, (index & 1u) == 0u);
    let prefixNibble = (prefix_byte(index) >> 4u) & 15u;
    if (((actual >> 4u) & 15u) != prefixNibble) {
      return false;
    }
  }

  return true;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  if (index >= params.batchSize) {
    return;
  }

  var point = point_identity();
  for (var window: u32 = 0u; window < WINDOW_COUNT; window = window + 1u) {
    point = point_add_precomp(point, window, scalar_digit(index, window));
  }

  let zInv = fe_pow_p_minus_2(point.Z);
  let y = fe_mul(point.Y, zInv);
  flags.values[index] = select(0u, 1u, matches_prefix(y));
}
`;

export class WebGpuEd25519Scanner {
  constructor() {
    this.adapter = null;
    this.device = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.tableBuffer = null;
    this.paramsBuffer = null;
    this.scalarBuffer = null;
    this.flagsBuffer = null;
    this.readBuffer = null;
    this.capacity = 0;
    this.initialized = false;
    this.backend = 'cpu';
  }

  async initialize() {
    if (this.initialized) {
      return true;
    }
    if (!navigator.gpu) {
      return false;
    }

    try {
      this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch (error) {
      console.warn('WebGPU adapter request failed, falling back to CPU:', error);
      return false;
    }

    if (!this.adapter) {
      return false;
    }

    try {
      this.device = await this.adapter.requestDevice();
    } catch (error) {
      console.warn('WebGPU device request failed, falling back to CPU:', error);
      return false;
    }
    this.backend = this.adapter.info?.description || 'webgpu';

    const module = this.device.createShaderModule({ code: shaderSource });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
      ]
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: { module, entryPoint: 'main' }
    });

    this.tableBuffer = this.device.createBuffer({
      size: Uint32Array.BYTES_PER_ELEMENT * PRECOMP_WORDS.length,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint32Array(this.tableBuffer.getMappedRange()).set(PRECOMP_WORDS);
    this.tableBuffer.unmap();

    this.paramsBuffer = this.device.createBuffer({
      size: 6 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.initialized = true;
    return true;
  }

  ensureCapacity(batchSize) {
    if (batchSize <= this.capacity) {
      return;
    }

    const nextCapacity = Math.max(batchSize, WORKGROUP_SIZE);

    this.scalarBuffer?.destroy();
    this.flagsBuffer?.destroy();
    this.readBuffer?.destroy();

    this.scalarBuffer = this.device.createBuffer({
      size: nextCapacity * 8 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    this.flagsBuffer = this.device.createBuffer({
      size: nextCapacity * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    this.readBuffer = this.device.createBuffer({
      size: nextCapacity * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    this.capacity = nextCapacity;
  }

  createBindGroup() {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.scalarBuffer } },
        { binding: 1, resource: { buffer: this.tableBuffer } },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
        { binding: 3, resource: { buffer: this.flagsBuffer } }
      ]
    });
  }

  async scanBatch(scalarWords, prefixBytes, prefixNibbleLength) {
    await this.initialize();
    if (!this.initialized) {
      throw new Error('WebGPU is not available');
    }

    const batchSize = scalarWords.length / 8;
    this.ensureCapacity(batchSize);

    const params = new Uint32Array([
      batchSize,
      prefixNibbleLength,
      prefixBytes[0] ?? 0,
      prefixBytes[1] ?? 0,
      prefixBytes[2] ?? 0,
      prefixBytes[3] ?? 0
    ]);

    this.device.queue.writeBuffer(this.scalarBuffer, 0, scalarWords);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.createBindGroup());
    pass.dispatchWorkgroups(Math.ceil(batchSize / WORKGROUP_SIZE));
    pass.end();

    encoder.copyBufferToBuffer(this.flagsBuffer, 0, this.readBuffer, 0, batchSize * Uint32Array.BYTES_PER_ELEMENT);
    this.device.queue.submit([encoder.finish()]);

    await this.readBuffer.mapAsync(GPUMapMode.READ, 0, batchSize * Uint32Array.BYTES_PER_ELEMENT);
    const copy = new Uint32Array(this.readBuffer.getMappedRange(0, batchSize * Uint32Array.BYTES_PER_ELEMENT)).slice();
    this.readBuffer.unmap();
    return copy;
  }

  async warmup() {
    if (!this.initialized) {
      return false;
    }
    const dummyScalars = new Uint32Array(WORKGROUP_SIZE * 8);
    await this.scanBatch(dummyScalars, [0xa0], 1);
    return true;
  }
}

export function packScalarBytesToWords(bytes) {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i += 1) {
    const offset = i * 4;
    words[i] = bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24);
  }
  return words;
}
