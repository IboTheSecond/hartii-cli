// Set the wallet profile before loading Vitest or any wallet modules.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const home = mkdtempSync(join(tmpdir(), 'hartii-cli-proof-'));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const monorepo = existsSync(join(repoRoot, 'scripts', 'build-hartii-cli-tarball.mjs'));
const cwd = monorepo ? repoRoot : packageRoot;
const args=process.argv.slice(2);
const hasFiles=args.some(arg=>!arg.startsWith('-')&&arg.endsWith('.mjs'));
const filters=monorepo?hasFiles?args.map(arg=>existsSync(join(packageRoot,arg))?'packages/hartii-cli/'+arg:arg):['packages/hartii-cli',...args]:args;
const result = spawnSync(process.execPath, [cli, 'run', ...filters], {
  cwd, env: { ...process.env, HARTII_HOME: home, HARTII_PASSWORD: '', HARTII_KEY: '' },
  stdio: 'inherit', windowsHide: true,
});
// Preserve isolated synthetic fixtures for investigation. Never recursively remove
// a directory containing deliberate filesystem links from a test launcher.
process.exitCode = result.error ? 1 : result.status ?? 1;
console.log(`hartii-cli-test-exit: ${process.exitCode}`);
