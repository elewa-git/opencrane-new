import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { executorStop } from '../src/computers/stop-executor.ts';

async function boundedTransport(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'executor-stop-'));
  const script = `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
let input = '';
process.stdin.on('data', collect);
process.stdin.on('end', finish);
function collect(chunk) { input += chunk; }
function finish() {
  process.stderr.write('protected-process');
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'large') { process.stdout.write('x'.repeat(16385)); return; }
  if (mode === 'failed') { process.exit(1); }
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({ request, args: process.argv.slice(2) }));
}
`;
  await writeFile(join(directory, 'kubectl'), script, { mode: 0o700 });
  vi.stubEnv('PATH', `${directory}:${process.env['PATH']}`);
  const input = { computerId: 'computer', podUid: 'pod', generation: 1,
    takeoverId: 'takeover', affectedTurnIds: ['protected-turn'] };
  try {
    const stop = executorStop('/fixture/config', 'test');
    if (mode !== 'success') {
      await expect(stop(input)).rejects.toThrow(/^Stop unavailable$/u);
      return;
    }
    expect(await stop(input)).toEqual({ request: input,
      args: ['--kubeconfig', '/fixture/config', '--namespace', 'test',
        'exec', '-i', 'computer', '-c', 'computer', '--',
        '/usr/bin/env', '-u', 'NODE_OPTIONS', '/usr/local/bin/node', '--disable-sigusr1',
        '--experimental-strip-types', '/app/src/stop-executor.ts'] });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}
it.each(['success', 'failed', 'large', 'timeout'])(
  'bounds the authenticated root stop transport and hides process errors: %s', boundedTransport);
