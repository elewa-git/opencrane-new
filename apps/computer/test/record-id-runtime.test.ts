import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);

async function copyPackagedEvents(directory: string) {
  const dockerfile = await readFile(join(root, 'apps/computer/Dockerfile'), 'utf8');
  const copyPattern = /^COPY --from=project (libs\/events\/\S+) (\/app\/libs\/events\/\S+)$/gmu;
  for (const match of dockerfile.matchAll(copyPattern)) {
    const source = match[1]!;
    const destination = join(directory, match[2]!.slice('/app/'.length));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, source), destination);
  }
}

async function prepareRuntime(directory: string) {
  await copyPackagedEvents(directory);
  await mkdir(join(directory, 'node_modules/@opencrane'), { recursive: true });
  await symlink('../../libs/events', join(directory, 'node_modules/@opencrane/events'));
  const zod = await realpath(join(root, 'node_modules/zod'));
  await symlink(zod, join(directory, 'node_modules/zod'));
  await mkdir(join(directory, 'src'));
  await copyFile(join(root, 'apps/computer/src/file-rules.ts'),
    join(directory, 'src/file-rules.ts'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
}

async function checksPackagedRecordIds() {
  const directory = await mkdtemp(join(tmpdir(), 'computer-record-id-'));
  const code = `
    import assert from 'node:assert/strict';
    import { sameJson } from '@opencrane/events/same-json';
    assert.equal(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    import { sha256Hex } from '@opencrane/events/digest';
    assert.equal(sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    import { isSafeId } from './src/file-rules.ts';
    assert.equal(isSafeId('record-1'), true);
    assert.equal(isSafeId('../record'), false);
    assert.equal(isSafeId('é'), false);
    console.log('PASS packaged record IDs');
  `;
  try {
    await prepareRuntime(directory);
    const result = await execute(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd: directory });
    expect(result.stdout.trim()).toBe('PASS packaged record IDs');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('checks upload IDs and digests using only event modules included in the computer image',
  checksPackagedRecordIds);
