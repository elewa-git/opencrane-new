import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-architecture-overview.mjs', import.meta.url));
const diagram = '```mermaid\nsequenceDiagram\nparticipant Browser\n' +
  'participant Server\nBrowser->>Server: Send\n```\n';
const validPage = '# Overview\n\n`message.posted` starts in `apps/server/entry.ts`.\n' +
  diagram.repeat(3);
let repository;

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'architecture-overview-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  mkdirSync(join(repository, 'apps/server'), { recursive: true });
  mkdirSync(join(repository, 'docs/architecture'), { recursive: true });
  writeFileSync(join(repository, 'apps/server/entry.ts'), '');
  execFileSync('git', ['add', 'apps/server/entry.ts'], { cwd: repository });
}

function removeRepository() {
  rmSync(repository, { recursive: true, force: true });
}

function runCheck(markdown) {
  writeFileSync(join(repository, 'docs/architecture/overview.md'), markdown);
  return spawnSync(process.execPath, ['--experimental-strip-types', checker], {
    cwd: repository, encoding: 'utf8',
  });
}

beforeEach(createRepository);
afterEach(removeRepository);

function acceptsValidOverview() {
  const result = runCheck(validPage);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('check:overview — OK');
}

test('accepts three small diagrams with a registered event and tracked file', acceptsValidOverview);

const invalidPages = [
  ['a made-up event', validPage + '`approval.requested`', 'Unknown event: approval.requested'],
  ['a missing file', validPage + '`apps/server/missing.ts`', 'Untracked path'],
  ['a missing diagram', diagram.repeat(2), 'exactly 3 sequence diagrams'],
  ['an extra diagram', diagram.repeat(4), 'exactly 3 sequence diagrams'],
  ['9 participants', validPage.replace('participant Browser',
    'participant A\nparticipant B\nparticipant C\nparticipant D\nparticipant E\n' +
    'participant F\nparticipant G\nparticipant Browser'), 'participants'],
  ['9 implicit participants', validPage.replace(diagram,
    '```mermaid\nsequenceDiagram\nA->>B: Send\nB->>C: Send\nC->>D: Send\nD->>E: Send\n' +
    'E->>F: Send\nF->>G: Send\nG->>H: Send\nH->>I: Send\n```\n'), 'participants'],
  ['26 arrows', validPage.replace('Browser->>Server: Send',
    'Browser-->>Server: Send\n'.repeat(26)), 'arrows'],
  ['26 arrows on one line', validPage.replace('Browser->>Server: Send',
    'Browser->>Server: Send;'.repeat(26)), 'arrows'],
  ['9 participants on one line', validPage.replace(diagram,
    '```mermaid\nsequenceDiagram\n' +
    'participant A;participant B;participant C;participant D;participant E;' +
    'participant F;participant G;participant H;participant I\n```\n'),
  'participants'],
  ['26 arrows hidden in quotes', validPage.replace('Browser->>Server: Send',
    'A->>B: "start;' + 'A->>B: Send;'.repeat(24) + 'A->>B: end"'), 'arrows'],
  ['9 participants hidden in quotes', validPage.replace('Browser->>Server: Send',
    'Browser->>Server: "start;participant C;participant D;participant E;participant F;' +
    'participant G;participant H;participant I;Browser->>Server: end"'), 'participants'],
  ['invalid quoted participant alias', validPage.replace('participant Browser',
    'participant Browser as "Browser; client";'), 'Parse error'],
  ['26 arrows with activation', validPage.replace('Browser->>Server: Send',
    'Browser->>+Server: Send\n'.repeat(26)), 'arrows'],
  ['more than 250 lines', validPage + '\n'.repeat(250), '250 lines'],
];

function refusesInvalidOverview(_name, markdown, message) {
  const result = runCheck(markdown);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
}

test.each(invalidPages)('refuses %s', refusesInvalidOverview);

function acceptsTrackedFolderAndOtherNames() {
  const result = runCheck(validPage + '`apps/server/` and `config.json` and `unknown.word`.');
  expect(result.status, result.stderr).toBe(0);
}

test('accepts tracked folders and names outside the event families',
  acceptsTrackedFolderAndOtherNames);

function refusesExistingUntrackedFile() {
  writeFileSync(join(repository, 'apps/server/untracked.ts'), '');
  const result = runCheck(validPage + '`apps/server/untracked.ts`');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Untracked path');
}

test('refuses an existing file which git does not track', refusesExistingUntrackedFile);

function acceptsLimits(arrow) {
  const participants = 'participant A\nparticipant B\nparticipant C\nparticipant D\n' +
    'participant E\nparticipant F\nparticipant G\nparticipant H\n';
  const maximumDiagram = '```mermaid\nsequenceDiagram\n' + participants +
    'loop Delivery\n' + `A${arrow}H: Send\n`.repeat(25) +
    'Note over A,H: Await the next delivery\nend\n```\n';
  const page = '# Overview\n' + maximumDiagram.repeat(3);
  const trimmedPage = page.trimEnd();
  const lines = trimmedPage.split('\n');
  const lineCount = lines.length;
  const result = runCheck(page + '\n'.repeat(250 - lineCount));
  expect(result.status, result.stderr).toBe(0);
}

test.each(['->>', '-->>', '->>+'])(
  'accepts 250 lines, 8 participants and 25 %s arrows per diagram', acceptsLimits);

function acceptsStatementPunctuation(statement) {
  const page = validPage.replace('participant Browser', statement);
  const result = runCheck(page);
  expect(result.status, result.stderr).toBe(0);
}

test.each([
  'participant Browser;',
  '%% A comment; with punctuation\nparticipant Browser',
])('accepts a single statement with punctuation: %s', acceptsStatementPunctuation);

function acceptsMessagePunctuation(message) {
  const page = validPage.replace('Browser->>Server: Send', message);
  const result = runCheck(page);
  expect(result.status, result.stderr).toBe(0);
}

test.each([
  'A->>B: hello#59; world',
  'A->>B: Send;%% comment; with punctuation',
])('accepts a valid message: %s', acceptsMessagePunctuation);

function acceptsRealOverview() {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', checker], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}

test('accepts the real architecture overview', acceptsRealOverview);
