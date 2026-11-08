import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images15/fixtures.test.py', import.meta.url),
);

function checkNpmDifferenceFixtures() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 25_000 });
}

test('npm source difference binds exact files and candidate bytes without approval',
  checkNpmDifferenceFixtures);
