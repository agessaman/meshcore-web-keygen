import { Point } from '@noble/ed25519';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOW_BITS = 8n;
const WINDOW_COUNT = 32;
const POINTS_PER_WINDOW = 255;
const LIMBS = 16;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const P = (1n << 255n) - 19n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../src');
const outFile = path.join(outDir, 'webgpu-ed25519-table.js');

function toU16Limbs(value) {
  const limbs = [];
  let current = value;
  for (let i = 0; i < LIMBS; i += 1) {
    limbs.push(Number(current & 0xffffn));
    current >>= 16n;
  }
  return limbs;
}

function pushPointWords(target, point) {
  const { x, y } = point.toAffine();
  const yPlusX = (y + x) % P;
  const yMinusX = (y - x + P) % P;
  const xy2d = (2n * D * x * y) % P;
  target.push(...toU16Limbs(yPlusX));
  target.push(...toU16Limbs(yMinusX));
  target.push(...toU16Limbs(xy2d));
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const words = [];
  let windowBase = Point.BASE;

  for (let window = 0; window < WINDOW_COUNT; window += 1) {
    let multiple = windowBase;
    for (let entry = 0; entry < POINTS_PER_WINDOW; entry += 1) {
      pushPointWords(words, multiple);
      multiple = multiple.add(windowBase);
    }
    for (let i = 0n; i < WINDOW_BITS; i += 1n) {
      windowBase = windowBase.add(windowBase);
    }
  }

  const source = `export const WINDOW_COUNT = ${WINDOW_COUNT};
export const POINTS_PER_WINDOW = ${POINTS_PER_WINDOW};
export const LIMBS_PER_COORD = ${LIMBS};
export const PRECOMP_WORDS = new Uint16Array(${JSON.stringify(words)});
`;

  await writeFile(outFile, source, 'utf8');
  console.log(`Wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
