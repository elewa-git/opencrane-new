import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('claim skips a slot with a held port and leaves it unclaimed', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-`);
  // Last port in the block: checking just the browser or database is insufficient.
  const held = createServer().listen(25110, '127.0.0.1');
  try {
    await once(held, 'listening');
    const { stdout } = await exec('infra/dev-stack/claim.sh', {
      env: { PATH: process.env['PATH'], HOME: home },
    });
    assert.equal(stdout.trim(), '2');
    await assert.rejects(stat(`${home}/.config/opencrane/dev-stack-1`), { code: 'ENOENT' });
    assert.ok((await stat(`${home}/.config/opencrane/dev-stack-2/stack-owner`)).isFile());
  } finally {
    await new Promise<void>(resolve => held.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
