import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-lint-debt.mjs', import.meta.url));
const override = '/* eslint max-lines: ["error", { max: 520, skipBlankLines: true, skipComments: true }] */';
const entry = { file: 'apps/example/src/large.ts', rule: 'max-lines', max: 520 };
let repository;
let base;

function git(...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function write(path, content) {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git('add', '--', path);
}

function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function setup() {
  repository = mkdtempSync(join(tmpdir(), 'lint-debt-'));
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  write('eslint.config.mjs', "export default [{rules: {'max-lines': ['error', 500]}}];\n");
  write(entry.file, `${override}\nexport const value = 1;\n`);
  json('scripts/lint-size-exceptions.json', [entry]);
  json('eslint-suppressions.json', {
    [entry.file]: { 'max-lines-per-function': { count: 1 }, 'max-params': { count: 2 } },
  });
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

function refusesAddedEntry() {
  const added = { file: 'libs/example/src/new.ts', rule: 'max-lines', max: 520 };
  write(added.file, `${override}\n`);
  json('scripts/lint-size-exceptions.json', [entry, added]);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('new size exception');
}

test('refuses an added size exception against the base commit', refusesAddedEntry);
