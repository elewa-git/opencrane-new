import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function includesPrivateProviderStartup() {
  const directory = await mkdtemp(join(tmpdir(), 'provider-build-context-'));
  const files = ['infra/package/model-settings.ts', 'infra/package/provider-secrets.mjs',
    'infra/dev-stack/journey-guard.ts', 'infra/dev-stack/model-stub.ts',
    'infra/dev-stack/chat-links-model.ts'];
  const dockerfile = join(directory, 'Dockerfile');
  const output = join(directory, 'output');
  try {
    const lines = ['FROM scratch'];
    for (const file of files) lines.push(`COPY ${file} /${file}`);
    await writeFile(dockerfile, lines.join('\n') + '\n');
    // Use the real root build context and its allow-list, without building the application.
    const args = ['build', '--quiet', '--file', dockerfile,
      '--output', `type=local,dest=${output}`, '.'];
    await execute('docker', args, { timeout: 120_000 });
    for (const file of files) {
      assert.equal(await readFile(join(output, file), 'utf8'), await readFile(file, 'utf8'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('the real Docker context includes provider custody startup and its runtime imports',
  includesPrivateProviderStartup);
