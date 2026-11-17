import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-ledger.mjs', import.meta.url));
const ids = ['#10', '#11'];
for (const [phase, count] of [[2, 7], [3, 22], [4, 28]]) {
  for (let index = 1; index <= count; index += 1) {
    ids.push(`P${phase}-${index}`);
  }
}
let repository;
let rows;

function makeRow(id) {
  return `| ${id} Capability | [Issue](https://example.invalid/issue) | No | NOT RUN | — |`;
}

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'ledger-'));
  mkdirSync(join(repository, 'docs/process'), { recursive: true });
  writeFileSync(join(repository, 'docs/process/receipt.md'), 'Fresh-install journey\n');
  rows = ids.map(makeRow);
}

function removeRepository() {
  rmSync(repository, { recursive: true, force: true });
}

function runCheck() {
  writeFileSync(join(repository, 'docs/process/ledger.md'), rows.join('\n'));
  const options = { cwd: repository, encoding: 'utf8' };
  return spawnSync(process.execPath, [checker], options);
}

beforeEach(createRepository);
afterEach(removeRepository);

function acceptsCompleteLedger() {
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('59 rows, 0 missing ids, 0 duplicated ids, 0 violations');
}
test('accepts the complete capability list', acceptsCompleteLedger);

function rejectsDuplicate() {
  rows.push(rows[0]);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('duplicated id: #10');
}
test('refuses a duplicated id', rejectsDuplicate);

function rejectsMissing() {
  rows.pop();
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('missing id: P4-28');
}
test('refuses a missing id', rejectsMissing);

function rejectsMissingReceipt() {
  rows[0] = rows[0].replace('NOT RUN', 'PASS 2026-11-17 `abcdef0`');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('#10: live result needs an existing receipt file');
}
test('refuses PASS without a receipt', rejectsMissingReceipt);

const unknownLabels = [['No', 'Merged'], ['NOT RUN', 'OK']];
function rejectsUnknownLabel(original, replacement) {
  rows[0] = rows[0].replace(original, replacement);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('#10: unknown');
}
test.each(unknownLabels)('refuses unknown label replacing %s', rejectsUnknownLabel);

const liveResults = ['PASS', 'FAIL', 'PARTIAL'];
function acceptsRecordedResult(label) {
  rows[0] = rows[0].replace('NOT RUN', `${label} 2026-11-17 \`abcdef0\``);
  rows[0] = rows[0].replace('—', '[Receipt](receipt.md#journey)');
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}
test.each(liveResults)('accepts %s with date, commit and local receipt', acceptsRecordedResult);

const incompleteResults = [
  ['PASS `abcdef0`', '[Receipt](receipt.md)', 'date and commit'],
  ['FAIL 2026-11-17', '[Receipt](receipt.md)', 'date and commit'],
  ['PARTIAL 2026-11-17 `abcdef0`', '[Receipt](missing.md)', 'existing receipt file'],
  ['PASS 2026-11-17 `abcdef0`', '[Receipt](https://example.invalid/receipt)', 'existing receipt file'],
];
function rejectsIncompleteResult(live, receipt, diagnostic) {
  rows[0] = rows[0].replace('NOT RUN', live);
  rows[0] = rows[0].replace('—', receipt);
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
}
test.each(incompleteResults)('refuses incomplete live evidence: %s', rejectsIncompleteResult);
