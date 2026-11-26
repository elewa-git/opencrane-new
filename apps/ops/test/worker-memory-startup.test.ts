import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';

async function refusesMalformedDatabaseUrlSafely() {
  const marker = 'synthetic-password-marker';
  const args = ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'memory'];
  const env = { ...process.env, MEMORY_PROJECTION_SCHEMA: 'opencrane_memory',
    DATABASE_URL: `postgres://memory:${marker}@[invalid-host/opencrane` };
  const child = spawn(process.execPath, args, { env });
  let output = '';
  function collect(chunk: Buffer) {
    output += chunk.toString();
  }
  child.stderr.on('data', collect);
  child.stdout.on('data', collect);
  const [status] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  expect(status).toBe(1);
  expect(output.includes(marker)).toBe(false);
  expect(output).toContain('Invalid Memory database address');
}
it('keeps a malformed database address out of worker startup diagnostics',
  refusesMalformedDatabaseUrlSafely);
