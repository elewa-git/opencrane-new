import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { personalRecallQualified } from '../../apps/server/src/chat/recall-qualification.ts';
import { collectEvidence } from './collect.ts';

const names = ['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
  'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence'];
const qualifications = ['P4-14', 'P4-15'];
const runtime = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, environmentId: 'fixture-host',
};
let directory: string;
let file: string;
let binding: typeof runtime & { runId: string; installationId: string; freshInstall: boolean };
let expected: typeof binding & { evidenceDigest: string };
type Row = { name: string; result: string; receiptDigest: string };
let evidence: typeof binding & { result: string; checks: Row[]; qualifications: Row[] };

function digest(bytes: string | Buffer): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}

function receipt(name: string): Row {
  const data = { ...binding, name, result: 'PASS', complete: true };
  const bytes = JSON.stringify(data);
  const receiptDigest = digest(bytes);
  writeFileSync(join(directory, `${receiptDigest.slice(7)}.json`), bytes);
  return { name, result: 'PASS', receiptDigest };
}

function save(): void {
  const bytes = JSON.stringify(evidence);
  writeFileSync(file, bytes);
  expected = { ...binding, evidenceDigest: digest(bytes) };
}

function current(): Promise<unknown> {
  return Promise.resolve(binding);
}

function prepare(): void {
  directory = mkdtempSync(join(tmpdir(), 'memory-evidence-'));
  file = join(directory, 'private-memory.json');
  binding = { ...runtime, runId: randomUUID(), installationId: randomUUID(), freshInstall: true };
  const checks = names.map(receipt);
  const completeQualifications = qualifications.map(receipt);
  evidence = { ...binding, result: 'PASS', checks, qualifications: completeQualifications };
  save();
}
beforeEach(prepare);

function clean(): void {
  rmSync(directory, { recursive: true, force: true });
}
afterEach(clean);

async function refused(reason: string): Promise<void> {
  const result = await collectEvidence(file, expected, current);
  expect(result).toEqual({ result: 'FAIL', reason });
}

async function parsesWithoutApproval(): Promise<void> {
  const before = readdirSync(directory);
  const result = await collectEvidence(file, expected, current);
  expect(result).toEqual({ result: 'NOT RUN', reason: 'live_launch_unavailable' });
  expect(personalRecallQualified(runtime, result)).toBe(false);
  expect(readdirSync(directory)).toEqual(before);
}
it('accepts synthetic parsing only, writes nothing and cannot qualify recall', parsesWithoutApproval);

async function refusesBadEvidence(kind: string): Promise<void> {
  rmSync(file);
  if (kind === 'malformed') {
    writeFileSync(file, '{');
  }
  if (kind === 'oversized') {
    writeFileSync(file, ' '.repeat(65_537));
  }
  if (kind === 'symlink') {
    symlinkSync(directory, file);
  }
  if (kind === 'directory') {
    file = directory;
  }
  await refused('evidence_invalid');
}
it.each(['absent', 'malformed', 'oversized', 'directory', 'symlink'])(
  'refuses %s evidence', refusesBadEvidence,
);

async function refusesChangedBytes(): Promise<void> {
  writeFileSync(file, `${JSON.stringify(evidence)} `);
  await refused('evidence_changed');
}
it('refuses changed evidence bytes', refusesChangedBytes);

async function refusesSubstitution(
  field: keyof typeof runtime | 'runId' | 'installationId',
): Promise<void> {
  const substitutes = {
    sourceSha: 'c'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`,
    environmentId: 'another-host', runId: randomUUID(), installationId: randomUUID(),
  };
  evidence[field] = substitutes[field];
  save();
  await refused('binding_invalid');
}
it.each(['sourceSha', 'imageDigest', 'environmentId', 'runId', 'installationId'] as const)(
  'refuses substituted %s and old receipts', refusesSubstitution,
);

async function refusesInvalidIdentity(field: keyof typeof runtime): Promise<void> {
  binding[field] = '';
  evidence[field] = '';
  save();
  await refused('binding_invalid');
}
it.each(['sourceSha', 'imageDigest', 'environmentId'] as const)(
  'refuses an invalid trusted %s even when evidence agrees', refusesInvalidIdentity,
);

async function requiresFreshInstall(): Promise<void> {
  binding.freshInstall = false;
  evidence.freshInstall = false;
  save();
  await refused('binding_invalid');
}
it('requires a fresh install', requiresFreshInstall);

async function requiresExactChecks(field: 'checks' | 'qualifications'): Promise<void> {
  const original = structuredClone(evidence[field]);
  for (const kind of ['missing', 'duplicate', 'unknown']) {
    evidence[field] = structuredClone(original);
    if (kind === 'missing') {
      evidence[field].pop();
    }
    if (kind === 'duplicate') {
      evidence[field][0] = evidence[field][1]!;
    }
    if (kind === 'unknown') {
      evidence[field][0]!.name = 'unknown';
    }
    save();
    await refused('checks_invalid');
  }
}
it.each(['checks', 'qualifications'] as const)('requires exact %s', requiresExactChecks);

async function refusesNonPassingResult(status: string): Promise<void> {
  for (const row of [...evidence.checks, ...evidence.qualifications]) {
    row.result = status;
    save();
    await refused('checks_invalid');
    row.result = 'PASS';
  }
  evidence.result = status;
  save();
  await refused('checks_invalid');
}
it.each(['FAIL', 'PARTIAL', 'NOT RUN'])('refuses PASS containing %s', refusesNonPassingResult);

async function refusesBadReceipt(kind: string): Promise<void> {
  const row = evidence.qualifications[0]!;
  const path = join(directory, `${row.receiptDigest.slice(7)}.json`);
  if (kind === 'missing') {
    rmSync(path);
  }
  if (kind === 'changed') {
    writeFileSync(path, '{}');
  }
  if (kind === 'oversized') {
    writeFileSync(path, ' '.repeat(16_385));
  }
  if (kind === 'wrong-name') {
    row.receiptDigest = evidence.checks[0]!.receiptDigest;
    save();
  }
  if (['incomplete', 'old-run', 'failed', 'fixture'].includes(kind)) {
    const data = { ...binding, name: row.name, result: 'PASS', complete: true };
    if (kind === 'incomplete') {
      data.complete = false;
    }
    if (kind === 'old-run') {
      data.runId = randomUUID();
    }
    if (kind === 'failed') {
      data.result = 'FAIL';
    }
    if (kind === 'fixture') {
      Object.assign(data, { fixture: true });
    }
    const bytes = JSON.stringify(data);
    row.receiptDigest = digest(bytes);
    writeFileSync(join(directory, `${row.receiptDigest.slice(7)}.json`), bytes);
    save();
  }
  await refused('receipt_invalid');
}
it.each(['missing', 'changed', 'oversized', 'incomplete', 'old-run', 'failed', 'fixture', 'wrong-name'])(
  'refuses %s receipt files', refusesBadReceipt,
);

async function refusesExtraClaims(): Promise<void> {
  Object.assign(evidence, { approved: true });
  save();
  await refused('checks_invalid');
}
it('refuses extra claims', refusesExtraClaims);

async function invalidatesReplacement(): Promise<void> {
  let observations = 0;
  function replacement(): Promise<unknown> {
    observations += 1;
    const installationId = observations === 1 ? binding.installationId : randomUUID();
    const replaced = { ...binding, installationId };
    return Promise.resolve(replaced);
  }
  const result = await collectEvidence(file, expected, replacement);
  expect(result).toEqual({ result: 'FAIL', reason: 'deployment_changed' });
}
it('invalidates collection after deployment replacement', invalidatesReplacement);

async function refusesConcurrentChange(kind: string): Promise<void> {
  let observations = 0;
  function change(): Promise<unknown> {
    observations += 1;
    if (observations === 2) {
      let path = file;
      if (kind === 'receipt') {
        path = join(directory, `${evidence.checks[0]!.receiptDigest.slice(7)}.json`);
      }
      writeFileSync(path, `${readFileSync(path, 'utf8')} `);
    }
    return current();
  }
  const result = await collectEvidence(file, expected, change);
  expect(result.result).toBe('FAIL');
}
it.each(['manifest', 'receipt'])('refuses %s changed during collection', refusesConcurrentChange);

async function hidesChildFailure(): Promise<void> {
  function failedChild(): Promise<unknown> {
    return Promise.reject(new Error('/private/example: secret child output'));
  }
  const result = await collectEvidence(file, expected, failedChild);
  expect(result).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('hides child failures, private paths and output', hidesChildFailure);
