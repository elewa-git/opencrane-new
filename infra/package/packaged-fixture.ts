import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { preProcessFile } from 'typescript';

const files = [
  'infra/dev-stack/bounded-input.ts',
  'infra/dev-stack/cnpg.ts',
  'infra/dev-stack/config.ts',
  'infra/dev-stack/identity.ts',
  'infra/dev-stack/packaged.ts',
  'infra/dev-stack/private-directories.ts',
  'infra/dev-stack/target.ts',
  'infra/package/journey-check.ts',
  'libs/event-store/test/certificates.ts',
];

async function checkImports(file: string) {
  const source = await readFile(file, 'utf8');
  const imports = preProcessFile(source, true, true);
  for (const imported of imports.importedFiles) {
    if (!imported.fileName.startsWith('.')) {
      continue;
    }
    const dependency = join(dirname(file), imported.fileName);
    assert.ok(files.includes(dependency),
      `Add ${dependency} to the packaged fixture files; ${file} imports it`);
  }
}

export async function copyPackagedFixture(worktree: string) {
  // Check every copied module so a new import names the missing fixture file immediately.
  for (const file of files) {
    await checkImports(file);
    const destination = join(worktree, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(file, destination);
  }
}
