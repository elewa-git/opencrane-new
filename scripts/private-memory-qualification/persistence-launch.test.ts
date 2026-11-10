import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function checksOwnershipAndCleanup(): void {
  const directory = mkdtempSync(join(tmpdir(), 'persistence-launch-'));
  const scripts = join(directory, 'scripts/private-memory-qualification');
  const stack = join(directory, 'infra/dev-stack');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stack, { recursive: true });
  try {
    copyFileSync('scripts/private-memory-qualification/persistence-launch.sh',
      join(scripts, 'persistence-launch.sh'));
    const claim = '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_CLAIM"\n';
    const start = '#!/bin/sh\nprintf "up %s\\n" "$*" >> "$FIXTURE_CALLS"\n' +
      'exit "$FIXTURE_START_STATUS"\n';
    const down = '#!/bin/sh\nprintf "down %s\\n" "$*" >> "$FIXTURE_CALLS"\n';
    const node = '#!/bin/sh\nprintf "attempt %s %s\\n" "$DEV_STACK_ID" ' +
      '"$MEMORY_CLAIMED_ID" >> "$FIXTURE_CALLS"\n' +
      'if [ "$FIXTURE_ATTEMPT_STATUS" = signal ]; then ' +
      'kill -TERM "$PPID"; exit 1; fi\nexit "$FIXTURE_ATTEMPT_STATUS"\n';
    const files: Array<readonly [string, string]> = [
      [join(stack, 'claim.sh'), claim], [join(stack, 'up.sh'), start],
      [join(stack, 'down.sh'), down], [join(directory, 'node'), node],
    ];
    for (const [path, content] of files) {
      writeFileSync(path, content, { mode: 0o755 });
    }
    const calls = join(directory, 'calls');
    const env = { ...process.env, PATH: `${directory}:/usr/bin:/bin`, FIXTURE_CALLS: calls,
      FIXTURE_CLAIM: '1', FIXTURE_START_STATUS: '0', FIXTURE_ATTEMPT_STATUS: '0' };
    function run(): number | null {
      const result = spawnSync('/bin/sh', [join(scripts, 'persistence-launch.sh')], { env });
      return result.status;
    }
    assert.equal(run(), 0);
    assert.equal(readFileSync(calls, 'utf8'),
      'up --id 1 --fresh\nattempt 1 1\ndown --id 1\n');
    writeFileSync(calls, '');
    env.FIXTURE_ATTEMPT_STATUS = 'signal';
    assert.equal(run(), 1);
    assert.equal(readFileSync(calls, 'utf8'),
      'up --id 1 --fresh\nattempt 1 1\ndown --id 1\n');
    writeFileSync(calls, '');
    env.FIXTURE_START_STATUS = '1';
    assert.equal(run(), 1);
    assert.equal(readFileSync(calls, 'utf8'), 'up --id 1 --fresh\ndown --id 1\n');
    writeFileSync(calls, '');
    env.FIXTURE_START_STATUS = '0';
    env.FIXTURE_ATTEMPT_STATUS = '1';
    assert.equal(run(), 1);
    assert.equal(readFileSync(calls, 'utf8'),
      'up --id 1 --fresh\nattempt 1 1\ndown --id 1\n');
    writeFileSync(calls, '');
    env.FIXTURE_CLAIM = 'owner';
    assert.equal(run(), 1);
    assert.equal(readFileSync(calls, 'utf8'), '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('the owning launcher claims a secondary and releases it on every exit',
  checksOwnershipAndCleanup);
