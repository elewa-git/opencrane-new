import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { commitBase } from './test/support/git-repository.mjs';

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

const flaggedCalls = [
  "store.readStream('x')",
  "store.readStream(\n'x',\n1,\nend\n)",
  "store.readStream('x', undefined)",
  "store?.readStream?.('x', 1)",
  'readEvents(source, 1, end)',
  'history(store, stream)',
];

function countsFlaggedCall(call) {
  writeFile(sourceFile, `${call};\n`);
  writeBaseline({ [sourceFile]: 1 });
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('known: 1');
  expect(result.stdout).toContain('rebuild: 0');
}

test.each(flaggedCalls)('counts the specified call: %s', countsFlaggedCall);

function ignoresOtherSyntax() {
  const content = [
    "store.readStream('x', 2); store.readStream('x', start);",
    "store.readStream(); readStream('x'); readEvents(source, 2);",
    "object.history(); object.readEvents(source, 1);",
    'function history() {}',
    'interface Store { readStream(name: string): void }',
    'class Store { readStream(name: string) {} }',
    "// history(); store.readStream('x');",
    'const text = "history();";',
  ];
  writeFile(sourceFile, content.join('\n'));
  writeFile('apps/server/src/example.test.ts', 'history();');
  writeFile('apps/web/src/example.ts', 'history();');
  writeFile('apps/computer/src/example.ts', 'history();');
  writeFile('libs/example/test/example.ts', 'history();');
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
}

test('ignores bounded reads, declarations, comments, strings, tests and other roots',
  ignoresOtherSyntax);

function checksAllRoots() {
  writeFile('apps/ops/src/example.ts', 'history();');
  writeFile('libs/example/src/nested/example.ts', 'history();');
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('apps/ops/src/example.ts:1');
  expect(result.stderr).toContain('libs/example/src/nested/example.ts:1');
}

test('scans ops and every library source folder', checksAllRoots);

function refusesChangedCount(actual) {
  writeFile(sourceFile, 'history();\n'.repeat(actual));
  writeBaseline({ [sourceFile]: 1 });
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(sourceFile);
  expect(result.stderr).toContain(`recorded 1, found ${actual}`);
}

test.each([0, 2])('refuses a stale baseline when the source contains %s reads', refusesChangedCount);

function refusesBaselineGrowth(initialCount) {
  writeFile(sourceFile, 'history();\n'.repeat(initialCount));
  if (initialCount > 0) writeBaseline({ [sourceFile]: initialCount });
  const base = commitBase(repository);
  writeFile(sourceFile, 'history();\nhistory();\n');
  writeBaseline({ [sourceFile]: 2 });
  const result = runCheck(base);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(sourceFile);
  if (initialCount === 0) expect(result.stderr).toContain('new baseline entry');
  else expect(result.stderr).toContain('rose from 1 to 2');
}

test.each([0, 1])('refuses baseline growth from %s against the base', refusesBaselineGrowth);

function allowsBaselineReduction() {
  writeFile(sourceFile, 'history();');
  writeBaseline({ [sourceFile]: 1 });
  const base = commitBase(repository);
  rmSync(join(repository, sourceFile));
  writeBaseline();
  const result = runCheck(base);
  expect(result.status, result.stderr).toBe(0);
}

test('allows removing a read and its record together', allowsBaselineReduction);

function countsRebuildReads() {
  writeFile('apps/ops/src/replay.ts', 'readEvents(source, 1, end);');
  const exceptions = structuredClone(rebuild);
  exceptions['apps/ops/src/replay.ts'].count = 1;
  writeBaseline({}, exceptions);
  const result = runCheck();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('known: 0; rebuild: 1');
}

test('counts rebuild reads separately', countsRebuildReads);

const invalidBaselines = [
  { known: { [sourceFile]: -1 }, rebuild },
  { known: { [sourceFile]: '1' }, rebuild },
  { known: { [sourceFile]: 0 }, rebuild },
  { known: {}, rebuild: {} },
  { known: {}, rebuild: { ...rebuild, [sourceFile]: { count: 1, reason: 'Extra' } } },
  { known: { 'apps/ops/src/replay.ts': 1 }, rebuild },
  { known: {}, rebuild: { ...rebuild, 'apps/ops/src/replay.ts': { count: 0, reason: '' } } },
];

function refusesInvalidBaseline(baseline) {
  writeFile('scripts/whole-stream-reads.json', JSON.stringify(baseline));
  const result = runCheck();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid whole-stream baseline');
}

test.each(invalidBaselines)('refuses an invalid baseline: %j', refusesInvalidBaseline);
