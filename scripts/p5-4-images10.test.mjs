import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images10/fixtures.test.py', import.meta.url),
);

function checkAttributionFixtures() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 25_000 });
}

test('libtabe attribution stays blocked against exact source and shipped bytes',
  checkAttributionFixtures);
