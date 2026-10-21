// Bundles the v2 adapter test (the app code uses import.meta.env and bare imports) and runs it with node:test.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
await build({ entryPoints: [`${here}adapter.test.mjs`], bundle: true, platform: 'node', format: 'esm', outfile: `${here}.out/adapter.test.mjs`,
  define: { 'import.meta.env': '{"DEV":false}' }, loader: { '.png': 'empty', '.svg': 'empty', '.css': 'empty' }, logLevel: 'error',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
const r = spawnSync(process.execPath, ['--test', `${here}.out/adapter.test.mjs`], { stdio: 'inherit' });
process.exit(r.status ?? 1);
