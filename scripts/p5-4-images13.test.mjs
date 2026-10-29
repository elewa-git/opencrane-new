import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images13/fixtures.test.py', import.meta.url),
);

function checkDependencyGrantFixtures() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 25_000 });
}

test('the Corepack ms grant matches its source and retained terms',
  checkDependencyGrantFixtures);
