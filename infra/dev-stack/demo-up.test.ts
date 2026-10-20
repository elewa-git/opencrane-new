import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

async function checksLauncher() {
  const directory = await mkdtemp(`${tmpdir()}/demo-up-`);
  const scripts = `${directory}/infra/dev-stack`;
  await mkdir(scripts, { recursive: true });
  await copyFile('infra/dev-stack/demo-up.sh', `${scripts}/demo-up.sh`);
  const executable = { mode: 0o755 };
  await writeFile(`${directory}/credential`, 'synthetic-credential');
  await writeFile(`${scripts}/claim.sh`, '#!/bin/sh\necho 1\n', executable);
  const record = '#!/bin/sh\nprintf "%s %s %s\\n" "$*" "$DEV_REAL_PROVIDER_FILE" ' +
    '"$COMPUTER_IDLE_MS" >> "$DEMO_RECORD"\nexit "${DEMO_FAILURE:-0}"\n';
  await writeFile(`${scripts}/up.sh`, record, executable);
  await writeFile(`${scripts}/down.sh`, '#!/bin/sh\necho "$*" >> "$DEMO_CLEANUP"\n', executable);
  await writeFile(`${directory}/node`, '#!/bin/sh\necho seed >> "$DEMO_RECORD"\n', executable);
  const environment = { PATH: `${directory}:/usr/bin:/bin`, HOME: directory,
    DEV_REAL_PROVIDER_FILE: `${directory}/credential`, DEMO_RECORD: `${directory}/calls`,
    DEMO_CLEANUP: `${directory}/cleanup` };
  function run(id?: string, failure = '0') {
    const env = { ...environment, DEV_STACK_ID: id, DEMO_FAILURE: failure };
    return spawnSync('/bin/sh', [`${scripts}/demo-up.sh`], { env, encoding: 'utf8' });
  }
  try {
    for (const id of [undefined, '', 'owner', '3']) assert.equal(run(id).status, 2);
    assert.equal(run('1').status, 0);
    const calls = await readFile(`${directory}/calls`, 'utf8');
    assert.equal(calls, `--id 1 --fresh ${directory}/credential 14400000\nseed\n`);
    assert.equal(run('1', '1').status, 1);
    assert.equal(await readFile(`${directory}/cleanup`, 'utf8'), '--id 1\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('launcher guards ids, claims, uses the file switch and cleans failed starts', checksLauncher);
