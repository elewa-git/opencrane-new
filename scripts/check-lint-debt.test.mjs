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

function refusesRaisedNumber() {
  json('scripts/lint-size-exceptions.json', [{ ...entry, max: 521 }]);
  write(entry.file, `${override.replace('520', '521')}\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('rose from 520 to 521');
}
test('refuses a raised cap', refusesRaisedNumber);

function refusesMissingComment() {
  write(entry.file, 'export const value = 1;\n');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no matching comment');
}
test('requires every listed exception to have a comment', refusesMissingComment);

function refusesRaisedTotal() {
  json('eslint-suppressions.json', { 'libs/example/src/new.ts': { 'max-params': { count: 3 } } });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('max-params suppressions rose from 2 to 3');
}
test('compares totals across files rather than individual suppression entries', refusesRaisedTotal);

function skipsMissingBase() {
  git('update-ref', '-d', 'refs/remotes/origin/main');
  const result = runCheck('');
  expect(result.status).toBe(0);
}
test('skips the comparison when there is no base commit', skipsMissingBase);

function allowsPrettierIntroduction() {
  write('.prettierrc.json', '{}\n');
  const added = { file: 'libs/example/src/new.ts', rule: 'max-lines', max: 521 };
  write(added.file, `${override.replace('520', '521')}\n`);
  json('scripts/lint-size-exceptions.json', [{ ...entry, max: 521 }, added]);
  write(entry.file, `${override.replace('520', '521')}\n`);
  json('eslint-suppressions.json', { [entry.file]: { 'max-params': { count: 3 } } });
  expect(runCheck().status).toBe(0);
  git('commit', '--quiet', '-m', 'Introduce formatting');
  base = git('rev-parse', 'HEAD');
  json('eslint-suppressions.json', { [entry.file]: { 'max-params': { count: 4 } } });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('max-params suppressions rose');
}
test('allows increases only in the commit range introducing Prettier', allowsPrettierIntroduction);

function refusesUnlistedOverride() {
  write('scripts/new.mjs', `${override}\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unlisted size exception');
}
test('finds new overrides in tracked scripts', refusesUnlistedOverride);

function refusesUnlistedDisable() {
  write('libs/example/src/new.ts', '// eslint-disable-next-line max-params, complexity\n');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('max-params: unlisted size exception');
  expect(result.stderr).toContain('complexity: unlisted size exception');
}
test('checks each protected rule in a disable directive', refusesUnlistedDisable);

function refusesUnnumberedLimit() {
  write(entry.file, '/* eslint-disable max-lines */\n');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('needs a numbered error limit');
}
test('rejects disabling a numbered file limit', refusesUnnumberedLimit);

function refusesCommentAboveList() {
  write(entry.file, `${override.replace('520', '521')}\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('comment exceeds listed limit 520');
}
test('checks the comment against its listed maximum', refusesCommentAboveList);

function refusesThirdConfigLimit() {
  const rule = "{rules: {'max-lines': ['error', 500]}}";
  write('eslint.config.mjs', `export default [${rule}, ${rule}, ${rule}];\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('max-lines may be set at most twice');
}
test('refuses a third file-size configuration', refusesThirdConfigLimit);

function ignoresStringsAndOtherRuleNames() {
  write('scripts/example.test.mjs', `const example = ${JSON.stringify(override)};\n`);
  write('eslint.config.mjs', `export default [{rules: {
    'max-lines': ['error', 500], 'max-lines-per-function': ['error', 80]
  }}, {rules: {'max-lines': ['error', 1500]}}];\n`);
  expect(runCheck().status).toBe(0);
}
test('ignores directive text in strings and the function-length configuration',
  ignoresStringsAndOtherRuleNames);

function allowsRecordedComplexity() {
  write('libs/example/src/decision.ts', '// eslint-disable-next-line complexity\n');
  const complexity = { file: 'libs/example/src/decision.ts', rule: 'complexity' };
  json('scripts/lint-size-exceptions.json', [entry, complexity]);
  expect(runCheck('').status).toBe(0);
}
test('allows the existing complexity disable without a numeric cap', allowsRecordedComplexity);

function allowsInitialLedgers() {
  git('rm', 'scripts/lint-size-exceptions.json', 'eslint-suppressions.json');
  git('commit', '--quiet', '-m', 'Base without debt ledgers');
  base = git('rev-parse', 'HEAD');
  json('scripts/lint-size-exceptions.json', [entry]);
  json('eslint-suppressions.json', { [entry.file]: { 'max-params': { count: 2 } } });
  expect(runCheck().status).toBe(0);
}

test('permits the initial debt ledgers when the base has neither', allowsInitialLedgers);

function refusesExtraRecordedDisable() {
  const file = 'libs/example/src/decision.ts';
  const complexity = { file, rule: 'complexity' };
  json('scripts/lint-size-exceptions.json', [entry, complexity]);
  write(file, '// eslint-disable-next-line complexity\n// eslint-disable-next-line complexity\n');
  const result = runCheck('');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('duplicate size exception comment');
}
test('cannot reuse one list entry to hide a second disable', refusesExtraRecordedDisable);

function refusesMultilineDisable() {
  write('libs/example/src/new.ts', '/* eslint-disable\n max-params\n */\n');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('max-params: unlisted size exception');
}
test('finds protected rules in multiline disable directives', refusesMultilineDisable);

function refusesAmbiguousCap() {
  write(entry.file, `${override.replace('max: 520,', 'max: 520, max: 9999,')}\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('needs a numbered error limit');
}
test('cannot hide a raised cap behind a duplicate property', refusesAmbiguousCap);

function refusesInlineSizeLimit(rule) {
  write('libs/example/src/new.ts', `/* eslint ${rule}: ["error", 9999] */\n`);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unlisted size exception');
}
const protectedOverrides = ['max-params', 'max-lines-per-function', 'max-depth', 'complexity'];
test.each(protectedOverrides)('cannot raise %s through an inline configuration',
  refusesInlineSizeLimit);
