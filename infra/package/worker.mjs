import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (!mode) throw new Error('Worker mode is missing');
const child = spawn(process.execPath, ['--experimental-strip-types',
  'apps/ops/src/worker.ts', mode], {
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
