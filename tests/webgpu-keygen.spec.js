import { expect, test } from '@playwright/test';

test('WebGPU flags agree with CPU derivation on a sampled batch', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { keyGenerator } = window.__meshcoreKeygen;
    await keyGenerator.initialize();
    if (!keyGenerator.webgpuScanner.initialized) {
      return { skipped: true };
    }

    keyGenerator.batchSize = 32;
    const prefix = 'A1';
    const prefixBytes = keyGenerator.prefixToBytes(prefix);
    const batch = await keyGenerator.generateCandidateBatch();
    const words = new Uint32Array(batch.scalars.length / 4);
    for (let i = 0; i < words.length; i += 1) {
      const offset = i * 4;
      words[i] = batch.scalars[offset]
        | (batch.scalars[offset + 1] << 8)
        | (batch.scalars[offset + 2] << 16)
        | (batch.scalars[offset + 3] << 24);
    }
    const flags = await keyGenerator.webgpuScanner.scanBatch(
      words,
      prefixBytes,
      prefix.length
    );
    const mismatches = [];
    for (let index = 0; index < 32; index += 1) {
      const scalar = batch.scalars.slice(index * 32, (index + 1) * 32);
      const publicKeyHex = keyGenerator.toHex(keyGenerator.derivePublicKeyBytes(scalar));
      const cpuMatch = publicKeyHex.startsWith(prefix) && !publicKeyHex.startsWith('00') && !publicKeyHex.startsWith('FF');
      const gpuMatch = flags[index] === 1;
      if (cpuMatch !== gpuMatch) {
        mismatches.push({ index, publicKeyHex, cpuMatch, gpuMatch });
      }
    }
    return { skipped: false, flagsLength: flags.length, mismatches };
  });

  expect(result.skipped).toBeFalsy();
  expect(result.flagsLength).toBe(32);
  expect(result.mismatches).toEqual([]);
});

test('End-to-end generation returns a CPU-validated key', async ({ page }) => {
  await page.goto('/?prefix=A&autostart=1');
  await page.waitForSelector('#resultContainer', { state: 'visible', timeout: 120000 });

  const publicKey = await page.locator('#publicKey').textContent();
  const privateKey = await page.locator('#privateKey').textContent();
  const validationText = await page.locator('.key-display .key-value').last().textContent();

  expect(publicKey).toMatch(/^[0-9A-F]{64}$/);
  expect(privateKey).toMatch(/^[0-9A-F]{128}$/);
  expect(publicKey.startsWith('A')).toBeTruthy();
  expect(validationText).toContain('CPU final gate passed');
});
