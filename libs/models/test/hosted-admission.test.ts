import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { retainAuthenticatedImageEvidence } from '../src/image-scan-evidence.ts';
import { envelope, history } from '../src/actor.ts';
import { writeHostedAdmission as rawWriter, readHostedAdmission, readHostedImageScanAttempt,
  foldHostedAdmission }
  from '../src/hosted-admission.ts';
import { writeHostedAdmission as exportedWriter } from
  '@opencrane/models/image-admission-writer';

let nats: Awaited<ReturnType<typeof natsFixture>>;
async function setup() {
  nats = await natsFixture();
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats.close();
}
beforeEach(setup);
afterEach(cleanup);

const now = new Date();
const digest = 'a'.repeat(64);
const dated = { verdict: 'pass', checkedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), engineVersion: '1',
  reportDigest: digest };
const scanned = { ...dated, databaseDigest: digest, databaseUpdatedAt: now.toISOString() };
function result(serverId: string) {
  return { serverId, attemptId: 1, imageDigest: digest, platform: 'linux/amd64',
    checks: { signature: dated, licence: dated, vulnerability: scanned, malware: scanned } };
}
async function writeTestAdmission(store: typeof nats.store, silo: string, raw: unknown,
  at?: Date) {
  const parsed = hostedImageCheckedSchema.safeParse(raw);
  const fallback = hostedImageCheckedSchema.parse(result('fallback'));
  const malware = parsed.success ? parsed.data.checks.malware : fallback.checks.malware;
  const scanEvidence = retainAuthenticatedImageEvidence({ malware });
  function evidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware });
  }
  return rawWriter(store, silo, raw, at, scanEvidence, evidence);
}

async function refusesUnvalidatedExport() {
  const serverId = await installed();
  const invented = result(serverId);
  // @ts-expect-error Check callers that omit the required private validator.
  const unchecked = await exportedWriter(nats.store, 'test', invented, now);
  expect(unchecked.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
  function invalidEvidence() {
    return Promise.resolve(false);
  }
  // @ts-expect-error Check runtime rejection of an incomplete validator result.
  const refused = await exportedWriter(nats.store, 'test', invented, now, undefined, invalidEvidence);
  expect(refused.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
}
it('refuses caller-authored malware facts without checked evidence at the package export',
  refusesUnvalidatedExport);

async function refusesIncompleteEvidence() {
  const serverId = await installed();
  const invented = hostedImageCheckedSchema.parse(result(serverId));
  const wrongMalware = { ...invented.checks.malware, reportDigest: 'b'.repeat(64) };
  const scanEvidence = retainAuthenticatedImageEvidence({ malware: invented.checks.malware });
  function mismatchedEvidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: wrongMalware });
  }
  const outcome = await exportedWriter(nats.store, 'test', invented, now,
    scanEvidence, mismatchedEvidence);
  expect(outcome.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
}
it('refuses validation of a different malware result', refusesIncompleteEvidence);

async function acceptsMatchingEvidence() {
  const serverId = await installed();
  const checked = hostedImageCheckedSchema.parse(result(serverId));
  const scanEvidence = retainAuthenticatedImageEvidence({ malware: checked.checks.malware });
  function matchingEvidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: checked.checks.malware });
  }
  const outcome = await exportedWriter(nats.store, 'test', checked, now,
    scanEvidence, matchingEvidence);
  expect(outcome.status).toBe('appended');
  expect(await registrations()).toHaveLength(2);
}
it('requires the validated malware result to match the event', acceptsMatchingEvidence);

async function refusesFabricatedMatchingEvidence() {
  const serverId = await installed();
  const invented = hostedImageCheckedSchema.parse(result(serverId));
  function inventedEvidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: invented.checks.malware });
  }
  const outcome = await exportedWriter(nats.store, 'test', invented, now,
    undefined, inventedEvidence);
  expect(outcome.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
}
it('refuses a caller-invented matching validator at the package export',
  refusesFabricatedMatchingEvidence);

async function refusesProofFromAnotherAttempt() {
  const serverId = await installed();
  const checked = hostedImageCheckedSchema.parse(result(serverId));
  const binding = { silo: 'test', serverId, attemptId: 1,
    imageDigest: digest, platform: 'linux/amd64' };
  const changes = [{ silo: 'other' }, { serverId: 'other' }, { attemptId: 2 },
    { imageDigest: 'b'.repeat(64) }, { platform: 'linux/arm64' }];
  function matchingEvidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: checked.checks.malware });
  }
  for (const change of changes) {
    const scanEvidence = retainAuthenticatedImageEvidence({ ...binding, ...change,
      malware: checked.checks.malware });
    const outcome = await exportedWriter(nats.store, 'test', checked, now,
      scanEvidence, matchingEvidence);
    expect(outcome.status).toBe('conflict');
    expect(await registrations()).toHaveLength(1);
  }
}
it('refuses scanner proof from another silo, server, attempt, image or platform',
  refusesProofFromAnotherAttempt);

async function refusesMalwareBoundary(kind: string) {
  const serverId = await installed();
  const eventTime = new Date(Date.now() - 5_000);
  const payload = hostedImageCheckedSchema.parse(result(serverId));
  const malware: Record<string, unknown> = { ...payload.checks.malware };
  if (kind === 'verdict') {
    malware['verdict'] = 'fail';
    malware['reasonCodes'] = ['infected'];
  }
  if (kind === 'expiry') {
    malware['expiresAt'] = new Date(Date.now() - 1_000).toISOString();
  }
  if (kind === 'database age') {
    malware['databaseUpdatedAt'] = new Date(Date.now() - 86_401_000).toISOString();
  }
  const edited = { ...payload, checks: { ...payload.checks, malware } };
  const checked = hostedImageCheckedSchema.parse(edited);
  const scanEvidence = retainAuthenticatedImageEvidence({ malware: checked.checks.malware });
  function evidence() {
    return Promise.resolve({ verdict: 'clean' as const, malware: checked.checks.malware });
  }
  const written = await exportedWriter(nats.store, 'test', checked, eventTime,
    scanEvidence, evidence);
  expect(written.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
}
it.each(['verdict', 'expiry', 'database age'])(
  'refuses the %s malware boundary even with a matching validator',
  refusesMalwareBoundary);

async function installed() {
  const serverId = 'hosted-test';
  const data = { serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `ghcr.io/elewa/test@sha256:${digest}`,
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'api.github.com', port: 443 } } };
  const event = envelope('test', `mcp-${serverId}`, 'mcp.server_registered', data);
  event.principal = { kind: 'human', id: 'alice' };
  const outcome = await nats.store.append({ event, expectedSequence: 0 });
  expect(outcome.status).toBe('appended');
  return serverId;
}
async function registrations() {
  return history(nats.store, 'mcp-hosted-test', 'test');
}

async function readsOnlyTheCurrentCheckingAttempt() {
  const serverId = await installed();
  const attempt = await readHostedImageScanAttempt(nats.store, 'test', serverId);
  expect(attempt).toEqual({ silo: 'test', serverId, attemptId: 1,
    imageDigest: digest, platform: 'linux/amd64', status: 'checking' });
  expect(await readHostedImageScanAttempt(nats.store, 'other', serverId)).toBeUndefined();
  const saved = await writeTestAdmission(nats.store, 'test', result(serverId), now);
  expect(saved.status).toBe('appended');
  expect(await readHostedImageScanAttempt(nats.store, 'test', serverId)).toBeUndefined();
}
it('reads only the saved checking attempt without calling a scanner',
  readsOnlyTheCurrentCheckingAttempt);
async function recoversResult() {
  const serverId = await installed();
  const payload = result(serverId);
  const append = nats.store.append.bind(nats.store);
  async function lostReply(input: Parameters<typeof append>[0]): ReturnType<typeof append> {
    await append(input);
    throw new Error('Lost reply');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lostReply);
  await expect(writeTestAdmission(nats.store, 'test', payload, now)).rejects.toThrow();
  expect((await writeTestAdmission(nats.store, 'test', payload, now)).status).toBe('appended');
  const changed = { ...payload, checks: { ...payload.checks,
    signature: { ...dated, engineVersion: '2' } } };
  expect((await writeTestAdmission(nats.store, 'test', changed, now)).status).toBe('conflict');
  const saved = await registrations();
  expect(saved).toHaveLength(2);
  expect(saved[1]?.event).toMatchObject({ type: 'mcp.image_checked', source: 'models',
    principal: { kind: 'system', id: 'models' }, data: payload });
  const admission = await readHostedAdmission(nats.store, 'test', serverId, now);
  expect(admission).toMatchObject({ status: 'admitted' });
}
it('recovers one saved models result after a lost reply and refuses changed retries', recoversResult);

const invalid = [
  { attemptId: 2 }, { imageDigest: 'b'.repeat(64) }, { platform: 'linux/arm64' },
  { serverId: 'unknown' },
  { checks: { signature: { ...dated, checkedAt: new Date(now.getTime() + 1).toISOString() } } },
  { checks: { signature: { ...dated,
    expiresAt: new Date(now.getTime() + 86_400_001).toISOString() } } },
  { checks: { malware: { ...scanned,
    databaseUpdatedAt: new Date(now.getTime() - 86_400_001).toISOString() } } },
  { checks: { signature: { verdict: 'not_run' } } },
  { checks: { signature: { ...dated, verdict: 'fail' } } },
  { checks: { signature: { ...dated, reportDigest: undefined } } },
  { checks: { signature: { ...dated, engineVersion: undefined } } },
  { checks: { signature: { ...dated, expiresAt: undefined } } },
  { checks: { malware: { ...scanned, databaseDigest: undefined } } },
  { checks: { vulnerability: { ...scanned, databaseUpdatedAt: undefined } } },
];
async function refusesResult(patch: Record<string, unknown>) {
  const serverId = await installed();
  const valid = result(serverId);
  const checkPatch = z.record(z.string(), z.unknown()).parse(patch['checks'] ?? {});
  const checks = { ...valid.checks, ...checkPatch };
  const payload = { ...valid, ...patch, checks };
  expect((await writeTestAdmission(nats.store, 'test', payload, now)).status).toBe('conflict');
  const rows = await history(nats.store, `mcp-${serverId}`, 'test');
  expect(rows).toHaveLength(1);
  const event = { ...rows[0]!.event, type: 'mcp.image_checked', data: payload,
    source: 'models', principal: { kind: 'system' as const, id: 'models' },
    time: now.toISOString() };
  expect(foldHostedAdmission([...rows, { event, sequence: 99 }], 'test', serverId, now))
    .toMatchObject({ status: 'checking' });
}
it.each(invalid)('refuses invalid writer and stored results %j', refusesResult);

async function expiresOldestDatabaseAndIgnoresSecondResult() {
  const serverId = await installed();
  const valid = result(serverId);
  const current = new Date();
  const malware = { ...scanned,
    databaseUpdatedAt: new Date(current.getTime() - 86_399_000).toISOString() };
  const payload = { ...valid, checks: { ...valid.checks, malware } };
  expect((await writeTestAdmission(nats.store, 'test', payload, current)).status).toBe('appended');
  const rows = await registrations();
  const boundary = new Date(current.getTime() + 1_000);
  expect(foldHostedAdmission(rows, 'test', serverId, new Date(boundary.getTime() - 1)))
    .toMatchObject({ status: 'admitted' });
  expect(foldHostedAdmission(rows, 'test', serverId, boundary)).toMatchObject({ status: 'expired' });
  const second = envelope('test', `mcp-${serverId}`, 'mcp.image_checked', valid, 'second', now);
  expect(foldHostedAdmission([...rows, { event: second, sequence: 99 }], 'test', serverId, boundary))
    .toMatchObject({ status: 'expired' });
}
it('expires at the oldest database boundary and ignores a second saved result',
  expiresOldestDatabaseAndIgnoresSecondResult);

async function serialisesDifferentResults() {
  const serverId = await installed();
  const first = result(serverId);
  const second = { ...first, checks: { ...first.checks,
    signature: { ...dated, engineVersion: '2' } } };
  const firstSave = writeTestAdmission(nats.store, 'test', first, now);
  const secondSave = writeTestAdmission(nats.store, 'test', second, now);
  const outcomes = await Promise.all([firstSave, secondSave]);
  expect(outcomes).toEqual(expect.arrayContaining([
    { status: 'appended' }, { status: 'conflict' },
  ]));
  expect(await registrations()).toHaveLength(2);
}
it('records only one result when different writers race', serialisesDifferentResults);

async function refusesForeignSilo() {
  const serverId = await installed();
  const outcome = await writeTestAdmission(nats.store, 'other', result(serverId), now);
  expect(outcome.status).toBe('conflict');
  expect(await registrations()).toHaveLength(1);
}
it('refuses to write a result for another silo', refusesForeignSilo);

async function refusesRemoteServer() {
  const serverId = 'remote';
  const data = { serverId, registeredBy: 'alice', kind: 'remote', locator: 'https://example.com' };
  const event = envelope('test', `mcp-${serverId}`, 'mcp.server_registered', data);
  event.principal = { kind: 'human', id: 'alice' };
  const saved = await nats.store.append({ event, expectedSequence: 0 });
  expect(saved.status).toBe('appended');
  const outcome = await writeTestAdmission(nats.store, 'test', result(serverId), now);
  expect(outcome.status).toBe('conflict');
  expect(await history(nats.store, 'mcp-remote', 'test')).toHaveLength(1);
}
it('refuses to write a result for a remote server', refusesRemoteServer);

async function recordsNonPassingResult(verdict: 'fail' | 'unavailable') {
  const serverId = await installed();
  const valid = result(serverId);
  const failed = { ...dated, verdict: 'fail', reasonCodes: ['unsigned'] };
  const receipt = verdict === 'fail' ? failed : { ...dated, verdict: 'unavailable' };
  const payload = { ...valid, checks: { ...valid.checks, signature: receipt } };
  const outcome = await writeTestAdmission(nats.store, 'test', payload, now);
  expect(outcome.status).toBe('appended');
  const expected = verdict === 'fail' ? 'rejected' : 'unavailable';
  const admission = await readHostedAdmission(nats.store, 'test', serverId, now);
  expect(admission).toMatchObject({ status: expected, checks: { signature: receipt } });
}
it.each(['fail', 'unavailable'] as const)(
  'records a models result with a %s check', recordsNonPassingResult);

async function writesOnlyCurrentAttempt() {
  const serverId = await installed();
  const valid = result(serverId);
  const failed = { ...valid, checks: { ...valid.checks,
    signature: { ...dated, verdict: 'fail', reasonCodes: ['unsigned'] } } };
  expect((await writeTestAdmission(nats.store, 'test', failed, now)).status).toBe('appended');
  const rows = await registrations();
  const data = { serverId, attemptId: 2, imageDigest: digest, platform: 'linux/amd64',
    registrationRevision: rows[0]!.sequence, expectedSequence: rows[1]!.sequence };
  const event = envelope('test', `mcp-${serverId}`, 'mcp.image_check_requested', data,
    'recheck', now);
  event.principal = { kind: 'human', id: 'alice' };
  const entry = { event, expectedSequence: rows[1]!.sequence };
  expect((await nats.store.append(entry)).status).toBe('appended');
  expect((await writeTestAdmission(nats.store, 'test', valid, now)).status).toBe('conflict');
  const next = { ...valid, attemptId: 2 };
  expect((await writeTestAdmission(nats.store, 'test', next, now)).status).toBe('appended');
  expect((await writeTestAdmission(nats.store, 'test', next, now)).status).toBe('appended');
  expect(await readHostedAdmission(nats.store, 'test', serverId, now))
    .toMatchObject({ status: 'admitted', attemptId: 2 });
  expect(await registrations()).toHaveLength(4);
}
it('keeps private result writes bound to the current requested attempt', writesOnlyCurrentAttempt);

async function refusesAlteredRequestHistory() {
  const serverId = await installed();
  const valid = result(serverId);
  const failed = { ...valid, checks: { ...valid.checks,
    signature: { ...dated, verdict: 'fail', reasonCodes: ['unsigned'] } } };
  await writeTestAdmission(nats.store, 'test', failed, now);
  const rows = await registrations();
  const data = { serverId, attemptId: 2, imageDigest: digest, platform: 'linux/amd64',
    registrationRevision: rows[0]!.sequence, expectedSequence: rows[1]!.sequence };
  const event = envelope('test', `mcp-${serverId}`, 'mcp.image_check_requested', data,
    'recheck', now);
  event.principal = { kind: 'human', id: 'alice' };
  for (const patch of [{ serverId: 'other' }, { imageDigest: 'b'.repeat(64) },
    { platform: 'linux/arm64' }, { registrationRevision: 999 }, { expectedSequence: 999 },
    { attemptId: 3 }, { attemptId: 1 }]) {
    const altered = { event: { ...event, data: { ...data, ...patch } }, sequence: 99 };
    expect(foldHostedAdmission([...rows, altered], 'test', serverId, now))
      .toMatchObject({ status: 'rejected', attemptId: 1 });
  }
  const system = { event: { ...event, principal: { kind: 'system' as const, id: 'models' } },
    sequence: 99 };
  expect(foldHostedAdmission([...rows, system], 'test', serverId, now))
    .toMatchObject({ status: 'rejected', attemptId: 1 });
  expect(foldHostedAdmission([...rows, rows[0]!], 'test', serverId, now)).toBeUndefined();
}
it('ignores altered request identities and refuses replaced registrations during replay',
  refusesAlteredRequestHistory);
