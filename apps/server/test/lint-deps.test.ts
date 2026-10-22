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
    const files = [
      'node_modules', '.dependency-cruiser.cjs', '.dependency-cruiser-tests.mjs',
      'tsconfig.base.json',
    ];
    for (const file of files) {
      await symlink(join(repository, file), join(directory, file));
    }
    const applications = ['computer', 'demo-mcp', 'odoo-mcp', 'ops', 'server', 'web'];
    for (const app of applications) {
      const source = join(directory, 'apps', app, 'src');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'fixture.ts'), 'export const fixture = true;\n');
      const tests = join(directory, 'apps', app, 'test');
      await mkdir(tests, { recursive: true });
      const ownImport = "import { fixture } from '../src/fixture.ts';\n";
      await writeFile(join(tests, 'fixture.test.ts'), ownImport);
    }
    await mkdir(join(directory, 'libs'), { recursive: true });
    const helper = "export { fixture } from '../src/fixture.ts';\n";
    await writeFile(join(directory, 'apps/computer/test/server.ts'), helper);
    const helperImport = "import { fixture } from '../../computer/test/server.ts';\n";
    await writeFile(join(directory, 'apps/server/test/helper.test.ts'), helperImport);
    const specification = join(directory, 'apps/server/src/fixture.spec.ts');
    await writeFile(specification, "import { fixture } from './fixture.ts';\n");
    const options = { cwd: directory, encoding: 'utf8' as const };
    await execute('npm', ['run', 'lint:deps'], options);
    for (const app of applications) {
      let otherApp = 'server';
      if (app === 'server') otherApp = 'computer';
      const forbiddenImport = `import { fixture } from '../../${otherApp}/src/fixture.ts';\n`;
      const testFile = join(directory, 'apps', app, 'test/fixture.test.ts');
      await writeFile(testFile, forbiddenImport);
    }
    const forbiddenSpecification = "import { fixture } from '../../computer/src/fixture.ts';\n";
    await writeFile(specification, forbiddenSpecification);
    const result = execute('npm', ['run', 'lint:deps'], options);
    const specificationPath = 'apps/server/src/fixture.spec.ts';
    await expect(result).rejects.toHaveProperty('stdout', expect.stringContaining(specificationPath));
    for (const app of applications) {
      const testPath = `apps/${app}/test/fixture.test.ts`;
      await expect(result).rejects.toHaveProperty('stdout', expect.stringContaining(testPath));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('lint:deps refuses a test importing another application source', rejectsCrossAppTestImport);
