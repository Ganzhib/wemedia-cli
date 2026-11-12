import { execFileSync } from 'node:child_process';
import { chmod, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { stdio: 'inherit' });
// A clean rebuild replaces npm link's executable file; restore every declared bin's mode.
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const entry of Object.values(metadata.bin)) await chmod(new URL('../' + entry, import.meta.url), 0o755);
