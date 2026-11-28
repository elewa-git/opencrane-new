import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function sourceRemainsReadableAfterPrivateExtraction() {
  const directory = await mkdtemp(join(tmpdir(), 'computer-permissions-'));
  const tag = `opencrane-computer-permissions:${randomUUID()}`;
  const files = ['app/src/example.ts', 'app/src/prompts/example.md',
    'app/libs/events/src/example.ts', 'app/package.json', 'app/package-lock.json', 'app/LICENSE',
    'scripts/private-memory-qualification/example.ts', 'apps/computer/src/private-codex.ts',
    'usr/local/bin/tool-user'];
  try {
    for (const file of files) {
      const path = join(directory, 'rootfs', file);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      await writeFile(path, file.endsWith('.json') ? '{}' : 'fixture', { mode: 0o600 });
    }
    const source = await readFile('apps/computer/Dockerfile', 'utf8');
    const afterCopy = source.split('COPY src ./src\n')[1];
    assert.ok(afterCopy, 'Use the real runtime permission commands');
    const permissions = afterCopy.split('\nENV PATH')[0];
    const dockerfile = [
      'FROM mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:' +
        '6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
      'WORKDIR /app', 'COPY rootfs/app/src/ /app/src/', 'COPY rootfs/app/libs/ /app/libs/',
      'COPY rootfs/app/package*.json /app/', 'COPY rootfs/app/LICENSE /app/LICENSE',
      'COPY rootfs/scripts/private-memory-qualification/ /scripts/private-memory-qualification/',
      'COPY rootfs/apps/computer/src/ /apps/computer/src/',
      'COPY rootfs/usr/local/bin/tool-user /usr/local/bin/tool-user', permissions,
    ].join('\n');
    await writeFile(join(directory, 'Dockerfile'), dockerfile);
    await execute('docker', ['build', '--quiet', '-t', tag, directory], { timeout: 120_000 });
    const script = `const fs = require('node:fs');
      for (const file of ${JSON.stringify(files)}) fs.readFileSync('/' + file);`;
    const args = ['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000',
      '--entrypoint', 'node', tag, '-e', script];
    await execute('docker', args, { timeout: 30_000 });
  } finally {
    await execute('docker', ['image', 'rm', '-f', tag]);
    await rm(directory, { recursive: true, force: true });
  }
}

test('the computer can read source extracted with private file permissions',
  sourceRemainsReadableAfterPrivateExtraction);
