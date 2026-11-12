import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

type Selection = { file: string; names?: string[]; treatment: string };
const selections: Selection[] = [
  { file: 'libs/event-store/src/jetstream.ts',
    names: ['EventStore', 'createEventStore', 'connectEventStore', 'eventsConfig',
      'verifyEventsConfig', 'defaults', 'otherChecks', 'readSubject',
      'conversationReadSubject', 'retryRead'], treatment: 'Replace the NATS adapter; keep its contract' },
  { file: 'libs/event-store/src/nats-connection.ts', treatment: 'Retire NATS connections' },
  { file: 'libs/event-store/src/certificates.ts', names: ['certificates'],
    treatment: 'Retire NKey/client identity creation; retain the generic TLS issuer' },
  { file: 'libs/handlers/src/dispatcher.ts',
    names: ['configuration', 'provisionDispatcher', 'durableConsumer'],
    treatment: 'Retire NATS consumer setup; retain pg-boss, enqueue and SQL checkpoint logic' },
  { file: 'infra/package/event-backup-run.ts', treatment: 'Retire the NATS archive CLI' },
  { file: 'infra/package/event-restore-run.ts', treatment: 'Retire the NATS restore CLI' },
  { file: 'infra/package/event-backup.ts',
    names: ['configSchema', 'withoutServerMetadata', 'stateSchema', 'infoSchema',
      'snapshotSchema', 'receiveSnapshot'],
    treatment: 'Retire NATS snapshot protocol; retain archive integrity and ownership checks' },
  { file: 'infra/package/event-restore.ts', names: ['checkInfo', 'transfer', 'checkConnections'],
    treatment: 'Retire NATS restore protocol; retain file, object and key custody checks' },
  { file: 'infra/package/prepare-nats-routes.ts', treatment: 'Retire NATS route preparation' },
  { file: 'infra/package/check-nats-inputs.ts', treatment: 'Retire NATS mounted-input checks' },
  { file: 'infra/package/nats-placement.ts', treatment: 'Retire NATS peer placement checks' },
  { file: 'infra/package/nats-placement-collect.ts', treatment: 'Retire NATS placement collection' },
];

function declarationName(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text;
  if (!ts.isVariableStatement(node)) return undefined;
  const declaration = node.declarationList.declarations[0];
  if (!declaration || !ts.isIdentifier(declaration.name)) return undefined;
  return declaration.name.text;
}

function inspect(selection: Selection) {
  const source = readFileSync(selection.file, 'utf8');
  const trimmed = source.trimEnd();
  const lines = trimmed.split('\n');
  const parsed = ts.createSourceFile(selection.file, source, ts.ScriptTarget.Latest, true);
  const ranges: { name: string; first: number; last: number; lines: number }[] = [];
  if (selection.names) {
    for (const statement of parsed.statements) {
      const name = declarationName(statement);
      if (!name || !selection.names.includes(name)) continue;
      const first = parsed.getLineAndCharacterOfPosition(statement.getStart(parsed)).line + 1;
      const last = parsed.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
      const range = { name, first, last, lines: last - first + 1 };
      ranges.push(range);
    }
    if (ranges.length !== selection.names.length) throw new Error('Inventory declaration missing');
  } else {
    const range = { name: 'whole file', first: 1, last: lines.length, lines: lines.length };
    ranges.push(range);
  }
  let candidates = 0;
  for (const range of ranges) candidates += range.lines;
  const hash = createHash('sha256');
  hash.update(source);
  const sha256 = hash.digest('hex');
  return { ...selection, physicalLines: lines.length, candidateLines: candidates, sha256, ranges };
}

const files = selections.map(inspect);
let candidateLines = 0;
for (const file of files) candidateLines += file.candidateLines;
const commandOptions = { encoding: 'utf8' as const };
const revision = execFileSync('git', ['rev-parse', 'origin/main'], commandOptions);
const baseSha = revision.trim();
const inventory = { baseSha, definition: 'Gross physical source lines in selected NATS implementations; '
  + 'includes comments and blanks within ranges, excludes tests and configuration. '
  + 'Replacement and caller edits are still needed. This is not a net deletion estimate.',
  candidateLines, files };
writeFileSync('spikes/s0-9-postgres-event-store/results/inventory.json',
  `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ candidateLines, files: files.length }));
