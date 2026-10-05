import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('claim skips a slot with a held port and leaves it unclaimed', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-`);
  const bin = `${home}/bin`;
  await mkdir(bin);
  await writeFile(`${bin}/docker`, '#!/bin/sh\nexit 0\n');
  await chmod(`${bin}/docker`, 0o755);
  // Model-stub port: checking just the browser or database is insufficient.
  const held = createServer().listen(25110, '127.0.0.1');
  try {
    await once(held, 'listening');
    const { stdout } = await exec('infra/dev-stack/claim.sh', {
      env: { PATH: `${bin}:${process.env['PATH']}`, HOME: home },
    });
    assert.equal(stdout.trim(), '2');
    await assert.rejects(stat(`${home}/.config/opencrane/dev-stack-1`), { code: 'ENOENT' });
    assert.ok((await stat(`${home}/.config/opencrane/dev-stack-2/stack-owner`)).isFile());
  } finally {
    await new Promise<void>(resolve => held.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('status leaves a free slot alone and claim reuses this worktree slot', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-repeat-`);
  const bin = `${home}/bin`;
  await mkdir(bin);
  await writeFile(`${bin}/docker`, '#!/bin/sh\nexit 0\n');
  await chmod(`${bin}/docker`, 0o755);
  const env = { PATH: `${bin}:${process.env['PATH']}`, HOME: home };
  const slotDirectory = `${home}/.config/opencrane/dev-stack-1`;
  try {
    const status = await exec('infra/dev-stack/run.sh', ['status', '--id', '1'], { env });
    assert.equal(status.stdout.trim(), 'free');
    await assert.rejects(stat(slotDirectory), { code: 'ENOENT' });
    const down = await exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env });
    assert.equal(down.stdout.trim(), 'free');
    await assert.rejects(stat(slotDirectory), { code: 'ENOENT' });

    const firstClaim = await exec('infra/dev-stack/claim.sh', { env });
    const secondClaim = await exec('infra/dev-stack/claim.sh', { env });
    assert.equal(firstClaim.stdout.trim(), '1');
    assert.equal(secondClaim.stdout.trim(), '1');
    assert.match(secondClaim.stderr, /Reclaimed stale slot 1\./u);

    const owner = await readFile(`${slotDirectory}/stack-owner`, 'utf8');
    assert.match(owner, /^worktree=.+\npid=\d+\nstartedAt=.+\nprocessStart=\d+\n$/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
