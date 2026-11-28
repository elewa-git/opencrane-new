import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function includesPrivateProviderStartup() {
  const directory = await mkdtemp(join(tmpdir(), 'provider-build-context-'));
  const files = ['infra/package/model-settings.ts', 'infra/package/provider-secrets.mjs',
    'infra/dev-stack/journey-guard.ts', 'infra/dev-stack/model-stub.ts',
    'infra/dev-stack/chat-links-model.ts', 'infra/dev-stack/file-sharing-model.ts',
    'infra/dev-stack/exec-tool-call.ts'];
  const dockerfile = join(directory, 'Dockerfile');
  const output = join(directory, 'output');
  try {
    const lines = ['FROM scratch'];
    for (const file of files) {
      lines.push(`COPY ${file} /${file}`);
    }
    // Use the real root build context and its allow-list, without building the application.
    for (const folder of ['libs', 'apps/server/src', 'infra/dev-stack', 'infra/package',
      'scripts/private-memory-qualification']) {
      lines.push(`COPY ${folder} /${folder}`);
    }
    await writeFile(dockerfile, lines.join('\n') + '\n');
    const args = ['build', '--quiet', '--file', dockerfile,
      '--output', `type=local,dest=${output}`, '.'];
    const buildOptions = { timeout: 120_000 };
    await execute('docker', args, buildOptions);
    await checksRecursiveRuntimeImports(output);
    for (const file of files) {
      assert.equal(await readFile(join(output, file), 'utf8'), await readFile(file, 'utf8'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void test('the real Docker context includes provider custody startup and its runtime imports',
  includesPrivateProviderStartup);

/** @param {string} output */
async function checksRecursiveRuntimeImports(output) {
  /** @type {Record<string, string>} */
  const sources = {};
  const options = { recursive: true };
  const entries = await readdir(output, options);
  for (const file of entries) {
    if (file.endsWith('.ts') || file.endsWith('.mjs')) {
      sources[file] = await readFile(join(output, file), 'utf8');
    }
  }
  const checker = 'infra/package/bootstrap-imports.mjs';
  function runChecker() {
    const child = execute(process.execPath, [checker]);
    child.child.stdin.end(JSON.stringify(sources));
    return child;
  }
  const result = await runChecker();
  assert.match(result.stdout, /PASS .* packaged runtime modules/u);
  const required = ['infra/dev-stack/file-sharing-model.ts', 'infra/dev-stack/exec-tool-call.ts'];
  for (const file of required) {
    const source = sources[file];
    delete sources[file];
    const failure = { stderr: 'FAIL packaged runtime imports\n' };
    await assert.rejects(runChecker, failure);
    sources[file] = source;
  }
}
