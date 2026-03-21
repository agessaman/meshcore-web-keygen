import * as nobleEd25519 from '../node_modules/@noble/ed25519/index.js';
import { WebGpuEd25519Scanner } from './webgpu-ed25519.js';

console.log('Using Web Crypto API for MeshCore key generation');
console.log('CPU cores available:', navigator.hardwareConcurrency || 'unknown');

const ED25519_ORDER = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;

const HASH_WORKER_SCRIPT = `
self.onmessage = async (event) => {
  const { type, batchSize } = event.data;
  if (type !== 'generate') {
    return;
  }

  const scalars = new Uint8Array(batchSize * 32);
  const scalarWords = new Uint32Array(batchSize * 8);
  const suffixes = new Uint8Array(batchSize * 32);

  for (let index = 0; index < batchSize; index += 1) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', seed));
    const scalarOffset = index * 32;
    const suffixOffset = index * 32;

    const clamped = digest.slice(0, 32);
    clamped[0] &= 248;
    clamped[31] &= 63;
    clamped[31] |= 64;

    scalars.set(clamped, scalarOffset);
    const wordOffset = index * 8;
    for (let word = 0; word < 8; word += 1) {
      const byteOffset = scalarOffset + word * 4;
      scalarWords[wordOffset + word] =
        clamped[byteOffset - scalarOffset]
        | (clamped[byteOffset - scalarOffset + 1] << 8)
        | (clamped[byteOffset - scalarOffset + 2] << 16)
        | (clamped[byteOffset - scalarOffset + 3] << 24);
    }
    suffixes.set(digest.slice(32, 64), suffixOffset);
  }

  self.postMessage(
    { type: 'results', scalars: scalars.buffer, scalarWords: scalarWords.buffer, suffixes: suffixes.buffer },
    [scalars.buffer, scalarWords.buffer, suffixes.buffer]
  );
};
`;

class MeshCoreKeyGenerator {
  constructor() {
    this.isRunning = false;
    this.attempts = 0;
    this.startTime = null;
    this.updateInterval = null;
    this.difficultyUpdateInterval = null;
    this.hashWorkers = [];
    this.numWorkers = Math.max(1, navigator.hardwareConcurrency || 4);
    this.batchSize = Math.max(8192, this.numWorkers * 1024);
    this.initialized = false;
    this.webgpuScanner = new WebGpuEd25519Scanner();
    this.backendLabel = 'cpu';
    this.autotuned = false;
    this.batchCandidates = [16384, 32768, 65536, 131072, 262144];
    this.runtimeTuning = {
      active: false,
      stopped: false,
      currentIndex: 0,
      bestIndex: 0,
      bestRate: 0,
      maxIndex: 0,
      batchesAtCurrent: 0,
      warmupBatches: 4,
      softBatchCeilingMs: 900,
      exploreEveryBatches: 6,
      minImprovementRatio: 1.03,
      regressionRatio: 0.95,
      stopReason: ''
    };
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    const gpuReady = await this.webgpuScanner.initialize();
    if (gpuReady) {
      await this.webgpuScanner.warmup();
      this.backendLabel = `webgpu + ${this.numWorkers} hash workers`;
    } else {
      this.backendLabel = `${this.numWorkers} cpu workers`;
    }

    await this.initializeHashWorkers();
    if (this.webgpuScanner.initialized) {
      await this.autotuneBatchSize();
    }
    this.initialized = true;
  }

  async initializeHashWorkers() {
    if (this.hashWorkers.length > 0) {
      return;
    }

    const blob = new Blob([HASH_WORKER_SCRIPT], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    for (let i = 0; i < this.numWorkers; i += 1) {
      this.hashWorkers.push(new Worker(workerUrl));
    }
  }

  async cleanup() {
    for (const worker of this.hashWorkers) {
      worker.terminate();
    }
    this.hashWorkers = [];
  }

  toHex(bytes) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  prefixToBytes(prefix) {
    const bytes = [];
    for (let i = 0; i < prefix.length; i += 2) {
      const slice = prefix.slice(i, i + 2);
      bytes.push(parseInt(slice.padEnd(2, '0'), 16));
    }
    return bytes;
  }

  scalarBytesToBigInt(scalarBytes) {
    let value = 0n;
    for (let i = 0; i < scalarBytes.length; i += 1) {
      value |= BigInt(scalarBytes[i]) << BigInt(8 * i);
    }
    return value;
  }

  derivePublicKeyBytes(clampedScalar) {
    const scalar = this.scalarBytesToBigInt(clampedScalar) % ED25519_ORDER;
    if (scalar === 0n) {
      throw new Error('Derived scalar reduced to zero');
    }
    return nobleEd25519.Point.BASE.multiply(scalar).toBytes();
  }

  selectBatchCandidates() {
    return this.batchCandidates.filter((size) => size >= this.numWorkers * 256);
  }

  async autotuneBatchSize() {
    if (this.autotuned || !this.webgpuScanner.initialized) {
      return;
    }

    const candidates = this.selectBatchCandidates();
    let bestSize = this.batchSize;
    let bestRate = 0;

    for (const size of candidates) {
      const previous = this.batchSize;
      this.batchSize = size;
      const start = performance.now();
      const batch = await this.generateCandidateBatch();
      await this.webgpuScanner.scanBatch(batch.scalarWords, [0xa0], 1);
      const elapsed = performance.now() - start;
      const rate = size / (elapsed / 1000);
      if (rate > bestRate) {
        bestRate = rate;
        bestSize = size;
      }
      this.batchSize = previous;
    }

    this.batchSize = bestSize;
    this.autotuned = true;
    this.initializeRuntimeTuning(bestSize);
    this.updateBackendLabel();
  }

  initializeRuntimeTuning(bestSize) {
    const currentIndex = Math.max(0, this.batchCandidates.indexOf(bestSize));
    this.runtimeTuning = {
      ...this.runtimeTuning,
      active: true,
      stopped: false,
      currentIndex,
      bestIndex: currentIndex,
      bestRate: 0,
      maxIndex: this.batchCandidates.length - 1,
      batchesAtCurrent: 0,
      stopReason: ''
    };
  }

  updateBackendLabel() {
    const base = this.webgpuScanner.initialized
      ? `webgpu + ${this.numWorkers} hash workers`
      : `${this.numWorkers} cpu workers`;
    const batchText = `batch ${this.batchSize.toLocaleString()}`;
    const suffix = this.runtimeTuning.stopped && this.runtimeTuning.stopReason
      ? ` | ${this.runtimeTuning.stopReason}`
      : '';
    this.backendLabel = `${base} | ${batchText}${suffix}`;
  }

  applyBatchSize(batchSize) {
    this.batchSize = batchSize;
    this.updateBackendLabel();
  }

  stopRuntimeTuning(reason) {
    this.runtimeTuning.stopped = true;
    this.runtimeTuning.active = false;
    this.runtimeTuning.stopReason = reason;
    this.applyBatchSize(this.batchCandidates[this.runtimeTuning.bestIndex]);
  }

  onRuntimeBatchFailure() {
    if (!this.runtimeTuning.active || this.runtimeTuning.stopped) {
      return;
    }
    this.runtimeTuning.maxIndex = Math.max(0, this.runtimeTuning.currentIndex - 1);
    this.stopRuntimeTuning('dynamic tune capped');
  }

  maybeTuneDuringRun(batchElapsedMs, rate) {
    if (!this.runtimeTuning.active || this.runtimeTuning.stopped || !this.webgpuScanner.initialized) {
      return;
    }

    const state = this.runtimeTuning;
    state.batchesAtCurrent += 1;

    if (rate > state.bestRate) {
      state.bestRate = rate;
      state.bestIndex = state.currentIndex;
    }

    if (batchElapsedMs >= state.softBatchCeilingMs) {
      state.maxIndex = Math.max(0, state.currentIndex - 1);
      this.stopRuntimeTuning('dynamic tune capped');
      return;
    }

    if (state.batchesAtCurrent < state.warmupBatches) {
      return;
    }

    if (state.currentIndex > state.bestIndex && rate < state.bestRate * state.regressionRatio) {
      state.maxIndex = Math.max(state.bestIndex, state.currentIndex - 1);
      this.stopRuntimeTuning('dynamic tune capped');
      return;
    }

    if (state.batchesAtCurrent < state.exploreEveryBatches) {
      return;
    }

    state.batchesAtCurrent = 0;

    const nextIndex = state.currentIndex + 1;
    if (nextIndex > state.maxIndex || nextIndex >= this.batchCandidates.length) {
      this.stopRuntimeTuning('dynamic tune settled');
      return;
    }

    if (state.bestRate > 0 && rate < state.bestRate * state.minImprovementRatio && state.currentIndex >= state.bestIndex) {
      this.stopRuntimeTuning('dynamic tune settled');
      return;
    }

    state.currentIndex = nextIndex;
    this.applyBatchSize(this.batchCandidates[nextIndex]);
  }

  async validateKeypair(privateKeyHex, publicKeyHex) {
    const privateKeyBytes = Uint8Array.from(privateKeyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    const publicKeyBytes = Uint8Array.from(publicKeyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));

    if (privateKeyBytes.length !== 64) {
      return { valid: false, error: 'Private key must be 64 bytes' };
    }
    if (publicKeyBytes.length !== 32) {
      return { valid: false, error: 'Public key must be 32 bytes' };
    }

    const clampedScalar = privateKeyBytes.slice(0, 32);
    if (clampedScalar.every((byte) => byte === 0)) {
      return { valid: false, error: 'Private key cannot be all zeros' };
    }
    if ((clampedScalar[0] & 7) !== 0) {
      return { valid: false, error: 'Private key scalar not properly clamped (bits 0-2 should be 0)' };
    }
    if ((clampedScalar[31] & 192) !== 64) {
      return { valid: false, error: 'Private key scalar not properly clamped (bit 6 should be 1, bit 7 should be 0)' };
    }

    const derivedPublicKey = this.derivePublicKeyBytes(clampedScalar);
    const derivedPublicHex = this.toHex(derivedPublicKey);
    if (derivedPublicHex !== publicKeyHex) {
      return { valid: false, error: 'Key verification failed: private key does not generate the claimed public key' };
    }

    return { valid: true };
  }

  async generateCandidateBatch() {
    if (this.hashWorkers.length === 0) {
      return this.generateCandidateBatchSingle();
    }

    const perWorker = Math.ceil(this.batchSize / this.hashWorkers.length);
    const batches = await Promise.all(
      this.hashWorkers.map((worker) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          reject(new Error('Hash worker timeout'));
        }, 30000);

        const onMessage = (event) => {
          if (event.data.type !== 'results') {
            return;
          }
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          resolve({
            scalars: new Uint8Array(event.data.scalars),
            scalarWords: new Uint32Array(event.data.scalarWords),
            suffixes: new Uint8Array(event.data.suffixes)
          });
        };

        const onError = (error) => {
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
          reject(error);
        };

        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({ type: 'generate', batchSize: perWorker });
      }))
    );

    const scalars = new Uint8Array(batches.reduce((sum, batch) => sum + batch.scalars.length, 0));
    const scalarWords = new Uint32Array(batches.reduce((sum, batch) => sum + batch.scalarWords.length, 0));
    const suffixes = new Uint8Array(batches.reduce((sum, batch) => sum + batch.suffixes.length, 0));

    let scalarOffset = 0;
    let scalarWordOffset = 0;
    let suffixOffset = 0;
    for (const batch of batches) {
      scalars.set(batch.scalars, scalarOffset);
      scalarWords.set(batch.scalarWords, scalarWordOffset);
      suffixes.set(batch.suffixes, suffixOffset);
      scalarOffset += batch.scalars.length;
      scalarWordOffset += batch.scalarWords.length;
      suffixOffset += batch.suffixes.length;
    }

    return { scalars, scalarWords, suffixes };
  }

  async generateCandidateBatchSingle() {
    const scalars = new Uint8Array(this.batchSize * 32);
    const scalarWords = new Uint32Array(this.batchSize * 8);
    const suffixes = new Uint8Array(this.batchSize * 32);
    for (let index = 0; index < this.batchSize; index += 1) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', seed));
      const scalarOffset = index * 32;
      const suffixOffset = index * 32;
      const clamped = digest.slice(0, 32);
      clamped[0] &= 248;
      clamped[31] &= 63;
      clamped[31] |= 64;
      scalars.set(clamped, scalarOffset);
      const wordOffset = index * 8;
      scalarWords[wordOffset] = clamped[0] | (clamped[1] << 8) | (clamped[2] << 16) | (clamped[3] << 24);
      scalarWords[wordOffset + 1] = clamped[4] | (clamped[5] << 8) | (clamped[6] << 16) | (clamped[7] << 24);
      scalarWords[wordOffset + 2] = clamped[8] | (clamped[9] << 8) | (clamped[10] << 16) | (clamped[11] << 24);
      scalarWords[wordOffset + 3] = clamped[12] | (clamped[13] << 8) | (clamped[14] << 16) | (clamped[15] << 24);
      scalarWords[wordOffset + 4] = clamped[16] | (clamped[17] << 8) | (clamped[18] << 16) | (clamped[19] << 24);
      scalarWords[wordOffset + 5] = clamped[20] | (clamped[21] << 8) | (clamped[22] << 16) | (clamped[23] << 24);
      scalarWords[wordOffset + 6] = clamped[24] | (clamped[25] << 8) | (clamped[26] << 16) | (clamped[27] << 24);
      scalarWords[wordOffset + 7] = clamped[28] | (clamped[29] << 8) | (clamped[30] << 16) | (clamped[31] << 24);
      suffixes.set(digest.slice(32, 64), suffixOffset);
    }
    return { scalars, scalarWords, suffixes };
  }

  async getMatchedIndexes(candidateBatch, prefixBytes, prefixLength) {
    const candidateCount = candidateBatch.scalars.length / 32;
    const matchedIndexes = [];
    const targetPrefix = this.currentTargetPrefix;

    if (this.webgpuScanner.initialized) {
      const flags = await this.webgpuScanner.scanBatch(candidateBatch.scalarWords, prefixBytes, prefixLength);
      for (let index = 0; index < flags.length; index += 1) {
        if (flags[index] === 1) {
          matchedIndexes.push(index);
        }
      }
      return { matchedIndexes, candidateCount };
    }

    for (let index = 0; index < candidateCount; index += 1) {
      const scalar = candidateBatch.scalars.slice(index * 32, (index + 1) * 32);
      const publicKeyHex = this.toHex(this.derivePublicKeyBytes(scalar));
      if (publicKeyHex.startsWith(targetPrefix) && !publicKeyHex.startsWith('00') && !publicKeyHex.startsWith('FF')) {
        matchedIndexes.push(index);
      }
    }
    return { matchedIndexes, candidateCount };
  }

  async generateVanityKey(targetPrefix, prefixLength) {
    this.isRunning = true;
    this.attempts = 0;
    this.startTime = Date.now();
    this.currentTargetPrefix = targetPrefix;

    const updateProgress = () => {
      if (!this.isRunning && this.attempts === 0) {
        return;
      }

      const elapsed = Math.max((Date.now() - this.startTime) / 1000, 0.001);
      const rate = this.attempts / elapsed;

      document.getElementById('attemptsCount').textContent = this.attempts.toLocaleString();
      document.getElementById('timeElapsed').textContent = `${elapsed.toFixed(1)}s`;
      document.getElementById('keysPerSecond').textContent = Math.round(rate).toLocaleString();

      const progressText = document.getElementById('progressText');
      progressText.textContent = `${this.attempts.toLocaleString()} attempts | ${Math.round(rate).toLocaleString()} keys/sec | ${elapsed.toFixed(1)}s elapsed [${this.backendLabel}]`;

      const expectedAttempts = Math.pow(16, prefixLength);
      const progress = Math.min((this.attempts / expectedAttempts) * 100, 99);
      document.getElementById('progressFill').style.width = `${progress}%`;
    };

    this.updateInterval = setInterval(updateProgress, 100);
    let lastDifficultyUpdate = 0;
    this.difficultyUpdateInterval = setInterval(() => {
      if (!this.isRunning) {
        return;
      }
      const elapsed = (Date.now() - this.startTime) / 1000;
      if (elapsed - lastDifficultyUpdate >= 10 && elapsed >= 10) {
        updateDifficultyEstimate(this.currentTargetPrefix, this.attempts / elapsed);
        lastDifficultyUpdate = elapsed;
      }
    }, 10000);

    const prefixBytes = this.prefixToBytes(targetPrefix);

    try {
      let nextBatchPromise = this.generateCandidateBatch();
      while (this.isRunning) {
        const batchStart = performance.now();
        let candidateBatch;
        try {
          candidateBatch = await nextBatchPromise;
        } catch (error) {
          this.onRuntimeBatchFailure();
          nextBatchPromise = this.generateCandidateBatch();
          continue;
        }
        nextBatchPromise = this.generateCandidateBatch();
        const { matchedIndexes, candidateCount } = await this.getMatchedIndexes(candidateBatch, prefixBytes, prefixLength);
        const batchElapsedMs = performance.now() - batchStart;
        const batchRate = candidateCount / (batchElapsedMs / 1000);
        this.maybeTuneDuringRun(batchElapsedMs, batchRate);

        this.attempts += candidateCount;

        for (const index of matchedIndexes) {
          const privateKeyBytes = new Uint8Array(64);
          const scalarOffset = index * 32;
          const suffixOffset = index * 32;
          privateKeyBytes.set(candidateBatch.scalars.slice(scalarOffset, scalarOffset + 32), 0);
          privateKeyBytes.set(candidateBatch.suffixes.slice(suffixOffset, suffixOffset + 32), 32);

          const publicKeyBytes = this.derivePublicKeyBytes(privateKeyBytes.slice(0, 32));
          const publicKeyHex = this.toHex(publicKeyBytes);
          if (publicKeyHex.startsWith('00') || publicKeyHex.startsWith('FF') || !publicKeyHex.startsWith(targetPrefix)) {
            continue;
          }

          const privateKeyHex = this.toHex(privateKeyBytes);
          const validation = await this.validateKeypair(privateKeyHex, publicKeyHex);
          if (!validation.valid) {
            continue;
          }

          this.isRunning = false;
          clearInterval(this.updateInterval);
          clearInterval(this.difficultyUpdateInterval);
          updateProgress();

          return {
            publicKey: publicKeyHex,
            privateKey: privateKeyHex,
            attempts: this.attempts,
            timeElapsed: (Date.now() - this.startTime) / 1000,
            validation
          };
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      clearInterval(this.updateInterval);
      clearInterval(this.difficultyUpdateInterval);
    }

    return null;
  }

  stop() {
    this.isRunning = false;
  }
}

const keyGenerator = new MeshCoreKeyGenerator();
window.__meshcoreKeygen = { keyGenerator, nobleEd25519 };

const form = document.getElementById('keygenForm');
const targetPrefixInput = document.getElementById('targetPrefix');
const generateBtn = document.getElementById('generateBtn');
const stopBtn = document.getElementById('stopBtn');
const progressContainer = document.getElementById('progressContainer');
const resultContainer = document.getElementById('resultContainer');
const errorContainer = document.getElementById('errorContainer');
const downloadBtn = document.getElementById('downloadBtn');
const importInfoBtn = document.getElementById('importInfoBtn');
const importModal = document.getElementById('importModal');
const closeModal = document.getElementById('closeModal');

function updateDifficultyEstimate(prefix, currentRate = null) {
  const prefixInfo = document.getElementById('prefixInfo');
  const prefixDifficulty = document.getElementById('prefixDifficulty');

  if (!prefix || prefix.length === 0) {
    prefixInfo.style.display = 'none';
    return;
  }

  const probability = 1 / Math.pow(16, prefix.length);
  const expectedAttempts = 1 / probability;

  let attemptsText;
  if (expectedAttempts >= 1e12) {
    attemptsText = `${(expectedAttempts / 1e12).toFixed(1)} trillion`;
  } else if (expectedAttempts >= 1e9) {
    attemptsText = `${(expectedAttempts / 1e9).toFixed(1)} billion`;
  } else if (expectedAttempts >= 1e6) {
    attemptsText = `${(expectedAttempts / 1e6).toFixed(1)} million`;
  } else if (expectedAttempts >= 1e3) {
    attemptsText = `${(expectedAttempts / 1e3).toFixed(1)} thousand`;
  } else {
    attemptsText = Math.round(expectedAttempts).toLocaleString();
  }

  const estimatedKeysPerSecond = currentRate || 10000;
  const estimatedSeconds = expectedAttempts / estimatedKeysPerSecond;

  let timeText;
  if (estimatedSeconds >= 31536000) {
    timeText = `${(estimatedSeconds / 31536000).toFixed(1)} years`;
  } else if (estimatedSeconds >= 2592000) {
    timeText = `${(estimatedSeconds / 2592000).toFixed(1)} months`;
  } else if (estimatedSeconds >= 86400) {
    timeText = `${(estimatedSeconds / 86400).toFixed(1)} days`;
  } else if (estimatedSeconds >= 3600) {
    timeText = `${(estimatedSeconds / 3600).toFixed(1)} hours`;
  } else if (estimatedSeconds >= 60) {
    timeText = `${(estimatedSeconds / 60).toFixed(1)} minutes`;
  } else {
    timeText = `${Math.round(estimatedSeconds)} seconds`;
  }

  let difficultyLevel;
  let difficultyColor;
  if (expectedAttempts <= 1000) {
    difficultyLevel = 'Very Easy';
    difficultyColor = '#27ae60';
  } else if (expectedAttempts <= 100000) {
    difficultyLevel = 'Easy';
    difficultyColor = '#2ecc71';
  } else if (expectedAttempts <= 10000000) {
    difficultyLevel = 'Moderate';
    difficultyColor = '#f39c12';
  } else if (expectedAttempts <= 1000000000) {
    difficultyLevel = 'Hard';
    difficultyColor = '#e67e22';
  } else if (expectedAttempts <= 100000000000) {
    difficultyLevel = 'Very Hard';
    difficultyColor = '#e74c3c';
  } else {
    difficultyLevel = 'Extreme';
    difficultyColor = '#8e44ad';
  }

  const rateText = `${Math.max(1, Math.round(estimatedKeysPerSecond)).toLocaleString()} keys/sec`;
  prefixDifficulty.innerHTML = `
    <div style="margin-bottom: 8px;">
      <span style="font-weight: 600; color: ${difficultyColor};">${difficultyLevel}</span> -
      Expected to find in ~${attemptsText} attempts
    </div>
    <div style="font-size: 13px; color: #7f8c8d;">
      Estimated time: ~${timeText} (at ${rateText})
    </div>
    <div style="font-size: 13px; color: #7f8c8d;">
      Probability: 1 in ${expectedAttempts.toLocaleString()} (${(probability * 100).toFixed(6)}%)
    </div>
  `;
  prefixInfo.style.display = 'block';
}

function checkReservedPrefix(prefix) {
  document.getElementById('reservedPrefixWarning')?.remove();
  const isReserved = prefix.length >= 2 && (prefix.startsWith('00') || prefix.startsWith('FF'));
  if (isReserved) {
    const warningDiv = document.createElement('div');
    warningDiv.id = 'reservedPrefixWarning';
    warningDiv.style.cssText = 'background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 12px; margin-top: 10px; color: #856404; font-size: 14px;';
    warningDiv.innerHTML = '<strong>Warning:</strong> Prefixes starting with "00" or "FF" are reserved by MeshCore and may cause unexpected behavior in the network.';

    const prefixInfo = document.getElementById('prefixInfo');
    if (prefixInfo && prefixInfo.style.display !== 'none') {
      prefixInfo.parentNode.insertBefore(warningDiv, prefixInfo.nextSibling);
    } else {
      targetPrefixInput.parentNode.appendChild(warningDiv);
    }

    generateBtn.disabled = true;
    return;
  }

  generateBtn.disabled = !(prefix.length > 0 && /^[0-9A-F]+$/.test(prefix) && prefix.length <= 8);
}

function showError(message) {
  errorContainer.textContent = message;
  errorContainer.style.display = 'block';
}

function hideError() {
  errorContainer.style.display = 'none';
}

function displayResult(result) {
  document.getElementById('publicKey').textContent = result.publicKey;
  document.getElementById('privateKey').textContent = result.privateKey;
  document.getElementById('attemptsCount').textContent = result.attempts.toLocaleString();
  document.getElementById('timeElapsed').textContent = `${result.timeElapsed.toFixed(1)}s`;
  document.getElementById('keysPerSecond').textContent = Math.round(result.attempts / result.timeElapsed).toLocaleString();

  resultContainer.querySelectorAll('.key-display').forEach((element) => {
    const label = element.querySelector('.key-label');
    if (label?.textContent === 'Validation Status:') {
      element.remove();
    }
  });

  const validationStatus = document.createElement('div');
  validationStatus.className = 'key-display';
  validationStatus.innerHTML = `
    <div class="key-label">Validation Status:</div>
    <div class="key-value" style="color: #27ae60; font-weight: bold;">
      CPU final gate passed: expanded private key and derived public key are consistent
    </div>
  `;

  const privateKeyDisplay = document.querySelector('.key-display:nth-child(3)');
  privateKeyDisplay.parentNode.insertBefore(validationStatus, privateKeyDisplay.nextSibling);

  resultContainer.style.display = 'block';
  resultContainer.scrollIntoView({ behavior: 'smooth' });
}

targetPrefixInput.addEventListener('input', (event) => {
  const prefix = event.target.value.trim().toUpperCase();
  if (/^[0-9A-F]*$/.test(prefix)) {
    updateDifficultyEstimate(prefix);
  }
  checkReservedPrefix(prefix);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') {
    showError('Error: Web Crypto API is not available in this browser.');
    return;
  }

  const targetPrefix = targetPrefixInput.value.trim().toUpperCase();
  if (!targetPrefix) {
    showError('Please enter a target prefix.');
    return;
  }
  if (targetPrefix.length > 8) {
    showError('Prefix must be between 1 and 8 characters long.');
    return;
  }
  if (!/^[0-9A-F]+$/.test(targetPrefix)) {
    showError('Prefix must contain only hexadecimal characters (0-9, A-F).');
    return;
  }
  if (targetPrefix.startsWith('00') || targetPrefix.startsWith('FF')) {
    showError('Prefixes starting with "00" or "FF" are reserved by MeshCore and cannot be used.');
    return;
  }

  hideError();
  resultContainer.style.display = 'none';
  progressContainer.style.display = 'block';
  generateBtn.disabled = true;
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop';
  stopBtn.className = 'btn btn-secondary';
  document.getElementById('progressText').textContent = 'Initializing WebGPU and hash workers...';

  try {
    await keyGenerator.initialize();
    const result = await keyGenerator.generateVanityKey(targetPrefix, targetPrefix.length);
    if (result) {
      displayResult(result);
    } else {
      showError('Key generation was stopped.');
    }
  } catch (error) {
    console.error(error);
    showError(`Error generating key: ${error.message}`);
  } finally {
    progressContainer.style.display = 'none';
    generateBtn.disabled = false;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Generate Another';
    stopBtn.className = 'btn btn-secondary';
  }
});

stopBtn.addEventListener('click', () => {
  if (stopBtn.textContent === 'Stop') {
    keyGenerator.stop();
    stopBtn.disabled = true;
    return;
  }
  resultContainer.style.display = 'none';
  form.dispatchEvent(new Event('submit'));
});

downloadBtn.addEventListener('click', () => {
  const publicKey = document.getElementById('publicKey').textContent;
  const privateKey = document.getElementById('privateKey').textContent;
  const targetPrefix = targetPrefixInput.value.trim().toUpperCase();
  const meshcoreData = { public_key: publicKey, private_key: privateKey };
  const blob = new Blob([JSON.stringify(meshcoreData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `meshcore_${targetPrefix}_${Date.now()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
});

importInfoBtn.addEventListener('click', () => {
  importModal.style.display = 'block';
});

closeModal.addEventListener('click', () => {
  importModal.style.display = 'none';
});

window.addEventListener('click', (event) => {
  if (event.target === importModal) {
    importModal.style.display = 'none';
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && importModal.style.display === 'block') {
    importModal.style.display = 'none';
  }
});

const urlParams = new URLSearchParams(window.location.search);
const urlPrefix = urlParams.get('prefix');
if (urlPrefix) {
  const cleanPrefix = urlPrefix.trim().toUpperCase();
  if (/^[0-9A-F]+$/.test(cleanPrefix) && cleanPrefix.length <= 8) {
    targetPrefixInput.value = cleanPrefix;
    updateDifficultyEstimate(cleanPrefix);
    checkReservedPrefix(cleanPrefix);
  }
} else {
  generateBtn.disabled = true;
}

targetPrefixInput.focus();

if (urlParams.get('autostart') === '1' && targetPrefixInput.value) {
  queueMicrotask(() => form.dispatchEvent(new Event('submit')));
}
