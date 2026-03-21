import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const tablePath = path.resolve(__dirname, '../src/webgpu-ed25519-table.js');
const scannerPath = path.resolve(__dirname, '../src/webgpu-ed25519.js');
const outPath = path.resolve(projectRoot, 'webgpu-ed25519-offline-simple.js');

function stripModuleSyntax(source) {
  return source
    .replace(/^import .*?;\r?\n/gm, '')
    .replace(/^export const /gm, 'const ')
    .replace(/^export class /gm, 'class ')
    .replace(/^export function /gm, 'function ');
}

async function main() {
  const [tableSource, scannerSource] = await Promise.all([
    readFile(tablePath, 'utf8'),
    readFile(scannerPath, 'utf8')
  ]);

  const bundle = `(function (global) {
${stripModuleSyntax(tableSource)}

${stripModuleSyntax(scannerSource)}

  function isUsableWebGpuModule() {
    return typeof navigator !== 'undefined'
      && typeof navigator.gpu !== 'undefined'
      && typeof WebGpuEd25519Scanner === 'function';
  }

  global.MeshCoreGpuModule = {
    WebGpuEd25519Scanner,
    packScalarBytesToWords,
    isUsableWebGpuModule
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;

  await writeFile(outPath, bundle, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
