import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-dependency-baseline.mjs', import.meta.url));
const cruiser = fileURLToPath(new URL('../node_modules/.bin/depcruise', import.meta.url));
const baselinePath = '.dependency-cruiser-known-violations.json';
let repository;
let base;

function git(...args) {
  const options = { cwd: repository, encoding: 'utf8' };
  const output = execFileSync('git', args, options);
  return output.trim();
}

function write(path, content) {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function recordViolations() {
  const args = ['apps', '--config', '.dependency-cruiser.cjs', '--output-type', 'baseline'];
  const options = { cwd: repository, encoding: 'utf8' };
  const result = spawnSync(cruiser, args, options);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  write(baselinePath, result.stdout);
}

function setup() {
  repository = mkdtempSync(join(tmpdir(), 'dependency-baseline-'));
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'fixture.invalid');
  const command = `depcruise apps --config .dependency-cruiser.cjs --ignore-known ${baselinePath}`;
  write('package.json', JSON.stringify({ scripts: { 'lint:deps': `${command} && unused` } }));
  write('.dependency-cruiser.cjs', `module.exports = {
    forbidden: [{name: 'cross-app', severity: 'error',
      from: {path: '^apps/one/'}, to: {path: '^apps/two/'}}]
  };\n`);
  write('apps/one/source.js', "import '../two/target.js';\n");
  write('apps/two/target.js', 'export const value = 1;\n');
  recordViolations();
  git('add', '.');
  git('commit', '--quiet', '-m', 'Fixture base');
  base = git('rev-parse', 'HEAD');
}

function cleanup() {
  rmSync(repository, { recursive: true, force: true });
}

function runCheck(baseSha = base) {
  const env = { ...process.env, BASE_SHA: baseSha };
  return spawnSync(process.execPath, [checker], { cwd: repository, encoding: 'utf8', env });
}

beforeEach(setup);
afterEach(cleanup);

function refusesStaleEntry() {
  write('apps/one/source.js', 'export const value = 1;\n');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no longer occurs');
  expect(result.stderr).toContain('apps/one/source.js');
}

test('requires a fixed violation to be removed from the baseline', refusesStaleEntry);

function refusesAddedEntry() {
  write('apps/one/extra.js', "import '../two/target.js';\n");
  recordViolations();
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Dependency baseline entries rose from 1 to 2');
}
test('refuses baseline growth against the base commit', refusesAddedEntry);

function refusesNewViolation() {
  write('apps/one/extra.js', "import '../two/target.js';\n");
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('new violation outside the baseline');
  expect(result.stderr).toContain('apps/one/extra.js');
}
test('refuses a new violation missing from the baseline', refusesNewViolation);

function allowsUnchangedBaseline() {
  expect(runCheck().status).toBe(0);
}
test('allows exactly the current recorded violations', allowsUnchangedBaseline);

function allowsShrinkingBaseline() {
  write('apps/one/source.js', 'export const value = 1;\n');
  recordViolations();
  expect(runCheck().status).toBe(0);
}
test('allows fixing and removing a recorded violation', allowsShrinkingBaseline);

function skipsMissingBase() {
  write('apps/one/extra.js', "import '../two/target.js';\n");
  recordViolations();
  expect(runCheck('').status).toBe(0);
  write('apps/one/source.js', 'export const value = 1;\n');
  const result = runCheck('');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no longer occurs');
}
test('skips only the count comparison when no base commit exists', skipsMissingBase);

function allowsInitialBaseline() {
  git('rm', baselinePath);
  git('commit', '--quiet', '-m', 'Base without dependency baseline');
  base = git('rev-parse', 'HEAD');
  recordViolations();
  expect(runCheck().status).toBe(0);
}
test('allows introducing the baseline when the base has no file', allowsInitialBaseline);

function refusesCruiseFailure() {
  write('.dependency-cruiser.cjs', 'invalid configuration;\n');
  expect(runCheck().status).toBe(1);
}
test('fails when dependency-cruiser cannot read the graph', refusesCruiseFailure);
