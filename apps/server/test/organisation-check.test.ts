// Every route must use the shared organisation check, so an identity allowed at
// sign-in is not refused later by a stricter copy of the rule.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const source = join(import.meta.dirname, '..', 'src');
// Claiming the first owner stays limited to the installation's own organisation.
const strictOnPurpose = ['members/bootstrap.ts'];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

it('compares the session organisation only through the shared check', async () => {
  const strict = /orgId\s*[!=]==\s*\w*\.?expectedOrgId|expectedOrgId\s*[!=]==\s*\w*\.?orgId/u;
  const offenders: string[] = [];
  for (const file of await sourceFiles(source)) {
    const name = file.slice(source.length + 1);
    if (strictOnPurpose.includes(name)) continue;
    if (strict.test(await readFile(file, 'utf8'))) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
