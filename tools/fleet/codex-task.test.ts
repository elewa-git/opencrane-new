import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

async function marksFleetChildren() {
  const directory = await mkdtemp(`${tmpdir()}/fleet-marker-`);
  try {
    const bin = `${directory}/bin`;
    await mkdir(bin);
    const fixture = '#!/bin/sh\n' +
      'printf "%s" "${OPENCRANE_FLEET_TASK-unset}" > "$FLEET_LOGS/marker"\n' +
      'while [ "$#" -gt 0 ]; do\n' +
      '  if [ "$1" = -o ]; then shift; printf "fixture" > "$1"; fi\n' +
      '  shift\n' +
      'done\n';
    await writeFile(`${bin}/codex`, fixture, { mode: 0o755 });
    const prompt = `${directory}/prompt.md`;
    await writeFile(prompt, 'Synthetic fixture; no task runs.');
    for (const inherited of [undefined, 'parent-task', '']) {
      const env: NodeJS.ProcessEnv = {
        HOME: directory, PATH: `${bin}:/usr/bin:/bin`, FLEET_LOGS: directory,
      };
      if (inherited !== undefined) {
        env['OPENCRANE_FLEET_TASK'] = inherited;
      }
      const args = [resolve('tools/fleet/codex-task.sh'), 'fixture', directory, prompt];
      const options = { env, encoding: 'utf8' as const, timeout: 5000 };
      const result = spawnSync('/bin/sh', args, options);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const marker = await readFile(`${directory}/marker`, 'utf8');
      assert.equal(marker, inherited ?? 'fixture');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('fleet children always receive a task marker and keep inherited markers', marksFleetChildren);
