import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const nobleSourcePath = path.resolve(projectRoot, 'node_modules/@noble/ed25519/index.js');
const nobleOutPath = path.resolve(projectRoot, 'noble-ed25519.js');

async function main() {
  await mkdir(projectRoot, { recursive: true });
  const nobleSource = await readFile(nobleSourcePath, 'utf8');
  await writeFile(nobleOutPath, nobleSource, 'utf8');
  console.log(`Wrote ${nobleOutPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
