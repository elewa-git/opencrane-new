import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkQualification, readQualification } from './check-local-qualification.mjs';

vi.mock('node:child_process', forbidExternalActions);
vi.mock('node:http', forbidExternalActions);
vi.mock('node:https', forbidExternalActions);
vi.mock('node:net', forbidExternalActions);

function forbidExternalActions() {
  throw new Error('The index checker must not load command or network clients.');
}

const rowIds = ['P5-1', 'P5-2', 'P5-3', 'P5-4', 'P5-5', 'P5-6a', 'P5-6b',
  'P5-7', 'P5-8', 'P5-9', 'P5-10', 'P5-11', 'P5-12', 'P5-13', 'P5-14'];
let directory;
let index;

function emptyRow(id) {
  return { id, status: 'NOT RUN', receipts: [], blockers: ['Live acceptance is missing.'] };
}

function passingReceipt() {
  return {
    status: 'PASS', kind: 'fresh', scope: 'product', source: 'a'.repeat(40),
    image: `sha256:${'b'.repeat(64)}`, environment: 'local',
    freshness: { state: 'twice-empty', detail: 'fixture-one and fixture-two; 2026-10-26 UTC.' },
    artefacts: ['proof.md'], failures: [], blockers: [],
    conditions: { 'guide-repeat': 'PASS', 'all-local-rows': 'PASS', 'hosting-and-findings': 'PASS' },
  };
}

function setUp() {
  directory = mkdtempSync(join(tmpdir(), 'qualification-'));
  writeFileSync(join(directory, 'proof.md'), 'A synthetic receipt, not product evidence.\n');
  index = {
    version: 1, hosting: { status: 'NOT RUN', blockers: ['Owner hosting approval is missing.'] },
    vulnerabilities: { status: 'PASS', artefacts: ['proof.md'], criticalHigh: [], blockers: [] },
    rows: rowIds.map(emptyRow),
  };
  index.rows[14] = { id: 'P5-14', status: 'PASS', receipts: [passingReceipt()], blockers: [] };
  vi.stubGlobal('fetch', vi.fn(forbidExternalActions));
}

function cleanUp() {
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
}

function check() {
  return checkQualification(index, directory);
}

beforeEach(setUp);
afterEach(cleanUp);

function acceptsCompleteProof() {
  expect(check()).toEqual(index);
  expect(fetch).not.toHaveBeenCalled();
}

function refusesMissingOrDuplicateRows(problem) {
  index.rows.splice(5, 1);
  if (problem === 'duplicate') {
    index.rows.push(structuredClone(index.rows[5]));
  }
  expect(check).toThrow('Qualification index refused');
}

function refusesAbsentMetadata(field) {
  delete index.rows[14].receipts[0][field];
  expect(check).toThrow('Qualification index refused');
}

function refusesBrokenArtefact() {
  index.rows[14].receipts[0].artefacts = ['private-canary-missing.md'];
  expect(check).toThrow('Qualification index refused: artefact.');
}

function refusesIncompleteProof(problem) {
  const receipt = index.rows[14].receipts[0];
  if (problem === 'PARTIAL') {
    receipt.status = 'PARTIAL';
  }
  if (problem === 'missing condition') {
    delete receipt.conditions['guide-repeat'];
  }
  if (problem === 'failed condition') {
    receipt.conditions['guide-repeat'] = 'FAIL';
  }
  if (problem === 'source' || problem === 'restored') {
    receipt.kind = problem;
  }
  if (problem === 'source freshness') {
    receipt.freshness.state = 'source';
  }
  expect(check).toThrow('Qualification index refused');
}

function checksCoordinatedScope(scope) {
  index.rows[14] = emptyRow('P5-14');
  const receipt = passingReceipt();
  receipt.kind = 'restored';
  receipt.scope = scope;
  receipt.freshness.state = 'restored';
  receipt.conditions = {
    'matched-set-refusals': 'PASS', 'replay-rights-files-audit-cents': 'PASS',
    'zero-repeated-effects': 'PASS',
  };
  index.rows[8] = { id: 'P5-8', status: 'PASS', receipts: [receipt], blockers: [] };
  if (scope === 'coordinated') {
    expect(check()).toEqual(index);
  } else {
    expect(check).toThrow('Qualification index refused: whole-row PASS.');
  }
}

function refusesVulnerabilityClearance(problem) {
  if (problem === 'absent') {
    delete index.vulnerabilities;
  }
  if (problem === 'empty scan') {
    index.vulnerabilities.artefacts = [];
  }
  if (problem === 'empty scan file') {
    writeFileSync(join(directory, 'scan.json'), '');
    index.vulnerabilities.artefacts = ['scan.json'];
  }
  if (problem === 'open High') {
    index.vulnerabilities.criticalHigh = ['Unresolved High fixture.'];
  }
  expect(check).toThrow('Qualification index refused');
}

function refusesLocalAsHosted() {
  index.rows[14].receipts[0].kind = 'hosted';
  expect(check).toThrow('Qualification index refused: environment.');
}

function retainsPartialResults() {
  const row = index.rows[14];
  row.status = 'PARTIAL';
  row.blockers = ['Guide execution NOT RUN.'];
  row.receipts[0].status = 'PARTIAL';
  row.receipts[0].failures = [' FAIL: browser capture, reason unknown; second install NOT RUN.\n'];
  row.receipts[0].blockers = [' No coordinated databases/WAL, objects or volumes.\n'];
  index.vulnerabilities = {
    status: 'NOT RUN', artefacts: [], criticalHigh: [], blockers: ['No dated image scan.'],
  };
  expect(check()).toEqual(index);
  expect(fetch).not.toHaveBeenCalled();
}

function refusesExternalArtefacts(artefact) {
  symlinkSync(tmpdir(), join(directory, 'escape'));
  index.rows[14].receipts[0].artefacts = [artefact];
  expect(check).toThrow('Qualification index refused: artefact.');
  expect(fetch).not.toHaveBeenCalled();
}

function refusesInvalidInput() {
  const path = join(directory, 'index.json');
  function read() {
    return readQualification(path, directory);
  }
  writeFileSync(path, ' '.repeat(1_048_577));
  expect(read).toThrow('Qualification index refused: input.');
  writeFileSync(path, 'private-canary');
  expect(read).toThrow('Qualification index refused: input.');
}

// Exercise the same public read operation that the command uses on committed data.
function readsRepositoryIndex() {
  const result = readQualification('docs/process/p5-14-pr1/qualification.json', process.cwd());
  expect(result.rows).toHaveLength(15);
  expect(result.rows[13].status).toBe('NOT RUN');
  expect(result.rows[14].status).toBe('NOT RUN');
  expect(fetch).not.toHaveBeenCalled();
}

test('accepts complete proof without commands or requests', acceptsCompleteProof);
test.each(['missing', 'duplicate'])('refuses a %s row', refusesMissingOrDuplicateRows);
test.each(['source', 'image', 'environment', 'freshness'])('refuses absent %s', refusesAbsentMetadata);
test('refuses a broken artefact without exposing its value', refusesBrokenArtefact);
const incomplete = ['PARTIAL', 'missing condition', 'failed condition', 'source', 'restored',
  'source freshness'];
test.each(incomplete)('refuses whole-row PASS from %s proof', refusesIncompleteProof);
test.each(['event-only', 'coordinated'])('checks %s restore scope', checksCoordinatedScope);
const missingScans = ['absent', 'empty scan', 'empty scan file', 'open High'];
test.each(missingScans)('refuses %s clearance', refusesVulnerabilityClearance);
test('refuses local evidence labelled hosted', refusesLocalAsHosted);
test('retains exact partial failures and blockers', retainsPartialResults);
const outside = ['https://example.invalid/proof', '../outside', 'escape'];
test.each(outside)('refuses external or escaping artefact %s', refusesExternalArtefacts);
test('bounds input and sanitises malformed JSON', refusesInvalidInput);
test('reads the committed partial index without commands or requests', readsRepositoryIndex);
