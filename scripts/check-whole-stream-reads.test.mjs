import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-whole-stream-reads.mjs', import.meta.url));
const sourceFile = 'apps/server/src/example.ts';
const rebuild = {
  'libs/projections/src/runner.ts': { count: 0, reason: 'Rebuild projections.' },
  'apps/ops/src/replay.ts': { count: 0, reason: 'Replay the event log.' },
  'libs/authz/src/rebuild.ts': { count: 0, reason: 'Rebuild access relations.' },
};
let repository;

function writeFile(file, content) {
  const target = join(repository, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeBaseline(known = {}, exceptions = rebuild) {
  writeFile('scripts/whole-stream-reads.json', JSON.stringify({ known, rebuild: exceptions }));
}

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'whole-stream-reads-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  writeBaseline();
}

function removeRepository() {
  rmSync(repository, { recursive: true, force: true });
}

function runCheck(base = '') {
  const env = { ...process.env, BASE_SHA: base };
  return spawnSync(process.execPath, [checker], { cwd: repository, encoding: 'utf8', env });
}

beforeEach(createRepository);
afterEach(removeRepository);

function refusesNewRead() {
  writeFile(sourceFile, "// Read a member.\nstore.readStream('member-x');\n");
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${sourceFile}:2`);
}

test('refuses a whole-stream read in a new product file with its file and line', refusesNewRead);
