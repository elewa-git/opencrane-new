import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images12/fixtures.test.py', import.meta.url),
);

function checkKubectlBuildFixtures() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 25_000 });
}

test('kubectl build information binds exact modules and complete Go terms',
  checkKubectlBuildFixtures);
