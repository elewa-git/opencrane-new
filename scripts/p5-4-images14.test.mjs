import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images14/fixtures.test.py', import.meta.url),
);

function checkNpmInventoryFixtures() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 25_000 });
}

test('npm inventory binds exact files and packages without approving licences',
  checkNpmInventoryFixtures);
