import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const fixtures = fileURLToPath(
  new URL('../docs/process/p5-4-images16/fixtures.test.py', import.meta.url),
);

function checkTypanionEvidence() {
  execFileSync('python3', [fixtures], { encoding: 'utf8', timeout: 30_000 });
}

test('the retained typanion range stays blocked unless its evidence matches', checkTypanionEvidence);
