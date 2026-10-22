import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../..');

async function rejectsCrossAppTestImport() {
  const directory = await mkdtemp(join(tmpdir(), 'lint-deps-'));
  try {
    const packageText = await readFile(join(repository, 'package.json'), 'utf8');
    await writeFile(join(directory, 'package.json'), packageText);
    for (const file of ['node_modules', '.dependency-cruiser.cjs', 'tsconfig.base.json']) {
      await symlink(join(repository, file), join(directory, file));
    }
    for (const app of ['computer', 'odoo-mcp', 'ops', 'server', 'web']) {
      const source = join(directory, 'apps', app, 'src');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'fixture.ts'), 'export const fixture = true;\n');
    }
    await mkdir(join(directory, 'libs'), { recursive: true });
    const tests = join(directory, 'apps/web/test');
    await mkdir(tests, { recursive: true });
    const forbiddenImport = "import { fixture } from '../../server/src/fixture.ts';\n";
    await writeFile(join(tests, 'fixture.test.ts'), forbiddenImport);
    const options = { cwd: directory, encoding: 'utf8' as const };
    await expect(execute('npm', ['run', 'lint:deps'], options)).rejects.toMatchObject({
      code: expect.any(Number),
      stdout: expect.stringContaining('apps/web/test/fixture.test.ts'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('lint:deps refuses a test importing another application source', rejectsCrossAppTestImport);
