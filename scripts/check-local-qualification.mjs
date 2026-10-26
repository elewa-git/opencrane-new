import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const requirements = {
  'P5-1': ['locked-images-licences', 'claim-liveness-cleanup', 'core-private-exposure-refusals'],
  'P5-2': ['twice-empty-distinct', 'verified-owner-core-1280-390', 'exposure-isolated-cleanup'],
  'P5-3': ['standby-all-databases-wal', 'backup-lsn-rows-checkpoints', 'storage-denials'],
  'P5-4': ['three-nodes-peers-r3', 'persistent-placement', 'tls-account-append-replay-refusals'],
  'P5-5': ['leader-loss-racing-acknowledgements', 'quorum-order-stale-position', 'peer-rejoin'],
  'P5-6a': ['real-clean-eicar', 'tls-caller-byte-silo-bindings', 'freshness-cleanup-rotation'],
  'P5-6b': ['two-silo-upload-image', 'copied-altered-expired-proof-refusals', 'outage-503-recovery'],
  'P5-7': ['quiesced-matched-components', 'positions-checksums-ownership-custody', 'admission-resume'],
  'P5-8': ['matched-set-refusals', 'replay-rights-files-audit-cents', 'zero-repeated-effects'],
  'P5-9': ['pinned-interrupted-upgrade', 'compatible-rollback-or-fresh-restore', 'state-access-refusals'],
  'P5-10': ['replica-reconnect-rights', 'replica-placement-budget-writer',
    'gateway-viewer-network-denials', 'requester-only-paused-takeover',
    'history-and-activity-preserve-access', 'outage-browser-1280-390-services'],
  'P5-11': ['twice-fresh-full-p3-22', 'all-phase3-refusals-real-rights-effects', 'screens-1280-390'],
  'P5-12': ['tombstones-current-keys-search-rights', 'native-no-disk', 'zero-model-tool-routine-effects'],
  'P5-13': ['twice-fresh-full-p4-28', 'all-phase4-refusals-phase2-3-regressions', 'screens-1280-390'],
  'P5-14': ['guide-repeat', 'all-local-rows', 'hosting-and-findings'],
};
const restoredRows = new Set(['P5-3', 'P5-8', 'P5-9', 'P5-12']);
const coordinatedRows = new Set(['P5-7', 'P5-8', 'P5-9', 'P5-12']);
const status = z.enum(['PASS', 'FAIL', 'PARTIAL', 'NOT RUN']);
const detail = z.string().min(1).max(1000).regex(/\S/);
const details = z.array(detail).max(32);
const artefacts = z.array(detail).max(16);
const receipt = z.object({
  status, kind: z.enum(['source', 'fresh', 'restored', 'hosted']),
  scope: z.enum(['source', 'event-only', 'coordinated', 'product']),
  source: detail, image: detail, environment: z.enum(['fixture', 'local', 'hosted']),
  freshness: z.object({
    state: z.enum(['source', 'empty', 'twice-empty', 'restored', 'NOT RUN']), detail,
  }).strict(),
  artefacts: artefacts.min(1), failures: details, blockers: details,
  conditions: z.record(z.string().max(100), status),
}).strict();
const schema = z.object({
  version: z.literal(1),
  hosting: z.object({ status: z.literal('NOT RUN'), blockers: details.min(1) }).strict(),
  vulnerabilities: z.object({ status, artefacts, criticalHigh: details, blockers: details }).strict(),
  rows: z.array(z.object({
    id: detail, status, receipts: z.array(receipt).max(16), blockers: details,
  }).strict()).length(15),
}).strict();

function refuse(reason) {
  throw new Error(`Qualification index refused: ${reason}.`);
}

function checkArtefact(path, root) {
  try {
    if (isAbsolute(path) || path.includes(':') || path.split('/').includes('..')) {
      refuse('artefact');
    }
    const resolved = realpathSync(resolve(root, path));
    const inside = relative(root, resolved);
    const file = statSync(resolved);
    if (inside.startsWith('..') || isAbsolute(inside) || !file.isFile() || file.size === 0) {
      refuse('artefact');
    }
  } catch {
    refuse('artefact');
  }
}

function checkReceipt(proof, rowId, root) {
  const hosted = proof.kind === 'hosted';
  if (hosted !== (proof.environment === 'hosted')) {
    refuse('environment');
  }
  for (const path of proof.artefacts) {
    checkArtefact(path, root);
  }
  for (const condition of Object.keys(proof.conditions)) {
    if (!requirements[rowId].includes(condition)) {
      refuse('condition');
    }
  }
  if (proof.status !== 'PASS' && proof.failures.length + proof.blockers.length === 0) {
    refuse('partial detail');
  }
}

function provesWholeRow(proof, rowId) {
  let expectedKind = 'fresh';
  if (restoredRows.has(rowId)) {
    expectedKind = 'restored';
  }
  let expectedScope = 'product';
  if (coordinatedRows.has(rowId)) {
    expectedScope = 'coordinated';
  }
  const required = { status: 'PASS', kind: expectedKind, environment: 'local', scope: expectedScope };
  for (const [field, value] of Object.entries(required)) {
    if (proof[field] !== value) {
      return false;
    }
  }
  if (proof.failures.length > 0 || proof.blockers.length > 0) {
    return false;
  }
  if (!/^[a-f0-9]{40}$/.test(proof.source)) {
    return false;
  }
  if (!/(?:^|@)sha256:[a-f0-9]{64}$/.test(proof.image)) {
    return false;
  }
  const freshness = proof.freshness.state;
  if (expectedKind === 'restored' && freshness !== 'restored') {
    return false;
  }
  if (expectedKind === 'fresh' && freshness !== 'empty' && freshness !== 'twice-empty') {
    return false;
  }
  const twiceFresh = ['P5-2', 'P5-11', 'P5-13'].includes(rowId);
  if (twiceFresh && freshness !== 'twice-empty') {
    return false;
  }
  for (const condition of requirements[rowId]) {
    if (proof.conditions[condition] !== 'PASS') {
      return false;
    }
  }
  return true;
}

function checkOperatorPrerequisites(rows) {
  const statuses = new Map();
  for (const row of rows) {
    statuses.set(row.id, row.status);
  }
  if (statuses.get('P5-14') !== 'PASS') {
    return;
  }
  // Keep operator completion tied to the prerequisites in the ticket catalogue.
  for (const id of ['P5-9', 'P5-10', 'P5-13']) {
    if (statuses.get(id) !== 'PASS') {
      refuse('prerequisites');
    }
  }
}

export function checkQualification(input, directory) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    refuse('shape');
  }
  const index = parsed.data;
  const root = realpathSync(directory);
  const scans = index.vulnerabilities;
  for (const path of scans.artefacts) {
    checkArtefact(path, root);
  }
  if (scans.status === 'PASS') {
    if (!scans.artefacts.length || scans.criticalHigh.length || scans.blockers.length) {
      refuse('vulnerability clearance');
    }
  } else if (!scans.blockers.length) {
    refuse('vulnerability blockers');
  }
  const seen = new Set();
  for (const row of index.rows) {
    if (!Object.hasOwn(requirements, row.id) || seen.has(row.id)) {
      refuse('rows');
    }
    seen.add(row.id);
    if ((row.status === 'PARTIAL' || row.status === 'FAIL') && !row.receipts.length) {
      refuse('recorded results');
    }
    let complete = false;
    for (const proof of row.receipts) {
      checkReceipt(proof, row.id, root);
      if (provesWholeRow(proof, row.id)) {
        complete = true;
      }
    }
    if (row.status === 'PASS') {
      if (!complete || row.blockers.length || scans.status !== 'PASS') {
        refuse('whole-row PASS');
      }
    } else if (!row.blockers.length) {
      refuse('row blockers');
    }
  }
  checkOperatorPrerequisites(index.rows);
  return index;
}

export function readQualification(path, root) {
  let descriptor;
  let input;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size > 1_048_576) {
      refuse('input');
    }
    const buffer = Buffer.alloc(1_048_577);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > 1_048_576) {
      refuse('input');
    }
    input = JSON.parse(buffer.toString('utf8', 0, length));
  } catch {
    refuse('input');
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  return checkQualification(input, root);
}

function main() {
  try {
    readQualification('docs/process/p5-14-pr1/qualification.json', process.cwd());
    console.log('PASS: index consistency only; live and hosted results remain as recorded.');
  } catch {
    console.error('Qualification index refused. Check local data and artefact links.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
