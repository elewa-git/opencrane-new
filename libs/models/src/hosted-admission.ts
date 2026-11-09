import { createHash, randomUUID } from 'node:crypto';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { getEventDefinition, hostedImageCheckedSchema, hostedImageCheckRequestedSchema,
  hostedImageScanClaimedSchema,
  type EventEnvelope } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { hostedAdmissionSchema } from '@opencrane/protocol';
import { z } from 'zod';
import { envelope } from './actor.ts';
import type { Binding } from '@opencrane/authz';
import { saveToolCommand } from './tool-policy.ts';
import { hasAuthenticatedImageEvidence } from './image-scan-evidence.ts';

type Result = z.infer<typeof hostedImageCheckedSchema>;
type Admission = z.infer<typeof hostedAdmissionSchema>;
type MalwareEvidence = Result['checks']['malware'];
type ValidatedMalwareEvidence = { verdict: 'clean'; malware: MalwareEvidence };
type ImageScanClaim = z.infer<typeof hostedImageScanClaimedSchema>;
const imageScanClaimInput = hostedImageScanClaimedSchema.omit({ claimToken: true });
type ImageScanClaimInput = z.infer<typeof imageScanClaimInput>;
const day = 86_400_000;

function validDates(result: Result, at: number) {
  for (const check of Object.values(result.checks)) {
    if (check.verdict === 'not_run') continue;
    const checked = Date.parse(check.checkedAt);
    const expiry = Date.parse(check.expiresAt);
    if (checked > at || expiry <= checked || expiry - checked > day) return false;
    if ('databaseUpdatedAt' in check) {
      const updated = Date.parse(check.databaseUpdatedAt);
      if (updated > checked || at - updated > day) return false;
    }
  }
  return true;
}

function resultStatus(result: Result, now: number): Admission['status'] {
  let unavailable = false;
  let expired = false;
  let failed = false;
  for (const check of Object.values(result.checks)) {
    if (check.verdict === 'fail') failed = true;
    if (check.verdict === 'not_run') continue;
    if (check.verdict === 'unavailable') unavailable = true;
    if (now >= Date.parse(check.expiresAt)) expired = true;
    if ('databaseUpdatedAt' in check && now >= Date.parse(check.databaseUpdatedAt) + day) {
      expired = true;
    }
  }
  if (unavailable) return 'unavailable';
  if (failed) return 'rejected';
  if (expired) return 'expired';
  return 'admitted';
}

function queuedAdmission(rows: StoredEvent[], silo: string, serverId: string): Admission | undefined {
  const first = rows[0]?.event;
  if (!first || first.type !== 'mcp.server_registered' || first.silo !== silo ||
      first.subject !== `mcp-${serverId}` || first.principal?.kind !== 'human') return;
  const schema = getEventDefinition(first.type)!.dataSchema;
  const parsed = schema.safeParse(first.data);
  if (!parsed.success) return;
  const registration = z.record(z.string(), z.unknown()).parse(parsed.data);
  if (registration['serverId'] !== serverId || registration['kind'] !== 'hosted' ||
      registration['registeredBy'] !== first.principal.id || !registration['installation']) return;
  const installation = z.object({ attemptId: z.literal(1),
    platform: hostedImageCheckedSchema.shape.platform }).parse(registration['installation']);
  const imageDigest = String(registration['locator']).split('@sha256:')[1]!;
  return { serverId, ...installation, imageDigest, queuedAt: first.time, status: 'checking' };
}

export function foldHostedAdmission(rows: StoredEvent[], silo: string, serverId: string,
  now = new Date()): Admission | undefined {
  let state = queuedAdmission(rows, silo, serverId);
  if (!state) return;
  for (let index = 1; index < rows.length; index++) {
    const event = rows[index]!.event;
    if (event.silo !== silo) {
      continue;
    }
    // Refuse replaced registrations until their separate installation is supported.
    if (event.type === 'mcp.server_registered') {
      return;
    }
    if (event.type === 'mcp.image_check_requested') {
      state = requestedAdmission(state, event, rows[0]!.sequence, rows[index - 1]!.sequence);
      continue;
    }
    if (state.checks || !modelsResult(event, silo, serverId)) {
      continue;
    }
    const checked = hostedImageCheckedSchema.safeParse(event.data);
    if (!checked.success || !matches(state, checked.data)) continue;
    const recordedAt = Date.parse(event.time);
    if (recordedAt > now.getTime() || !validDates(checked.data, recordedAt)) continue;
    state = { ...state, checks: checked.data.checks,
      status: resultStatus(checked.data, now.getTime()) };
  }
  return state;
}

function requestedAdmission(state: Admission, event: EventEnvelope,
  registrationRevision: number, previousSequence: number): Admission {
  const request = hostedImageCheckRequestedSchema.safeParse(event.data);
  if (!request.success || event.subject !== `mcp-${state.serverId}` ||
      event.principal?.kind !== 'human' ||
      request.data.registrationRevision !== registrationRevision ||
      request.data.expectedSequence !== previousSequence ||
      !eligibleRequest(state, request.data, Date.parse(event.time))) {
    return state;
  }
  return { serverId: state.serverId, imageDigest: state.imageDigest, platform: state.platform,
    attemptId: request.data.attemptId, queuedAt: event.time, status: 'checking' };
}

function eligibleRequest(state: Admission,
  request: z.infer<typeof hostedImageCheckRequestedSchema>, at: number) {
  if (!state.checks || state.serverId !== request.serverId ||
      state.imageDigest !== request.imageDigest || state.platform !== request.platform ||
      request.attemptId !== state.attemptId + 1) {
    return false;
  }
  const status = resultStatus({ ...state, checks: state.checks }, at);
  return status === 'rejected' || status === 'expired';
}

function modelsResult(event: EventEnvelope, silo: string, serverId: string) {
  return event.type === 'mcp.image_checked' && event.silo === silo &&
    event.subject === `mcp-${serverId}` && event.source === 'models' &&
    event.principal?.kind === 'system' && event.principal.id === 'models';
}
function matches(state: Admission, result: ImageScanClaimInput) {
  return state.serverId === result.serverId && state.attemptId === result.attemptId &&
    state.imageDigest === result.imageDigest && state.platform === result.platform;
}
function same(first: unknown, second: unknown) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  const firstDigest = losslessJson(firstJson).digest;
  const secondDigest = losslessJson(secondJson).digest;
  return firstDigest === secondDigest;
}
async function rowsFor(store: EventStore, serverId: string) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`mcp-${serverId}`, 1, performance.now() + 10_000)) {
    rows.push(row);
  }
  return rows;
}
export async function readHostedAdmission(store: EventStore, silo: string, serverId: string,
  now?: Date) {
  const rows = await rowsFor(store, serverId);
  return foldHostedAdmission(rows, silo, serverId, now ?? new Date());
}

export async function readHostedImageScanAttempt(store: EventStore, silo: string,
  serverId: string) {
  const admission = await readHostedAdmission(store, silo, serverId);
  if (!admission || admission.status !== 'checking' || admission.checks) return;
  // Keep the saved attempt separate from image bytes supplied to the scanner.
  return { silo, serverId: admission.serverId, attemptId: admission.attemptId,
    platform: admission.platform, imageDigest: admission.imageDigest,
    status: 'checking' as const };
}

function scanClaimMatches(event: EventEnvelope, silo: string, claim: ImageScanClaim) {
  if (event.type !== 'mcp.image_scan_claimed' || event.silo !== silo ||
      event.subject !== `mcp-${claim.serverId}` || event.source !== 'models' ||
      event.principal?.kind !== 'system' || event.principal.id !== 'models') return false;
  const parsed = hostedImageScanClaimedSchema.safeParse(event.data);
  return parsed.success && same(parsed.data, claim);
}

function claimAlreadySaved(event: EventEnvelope, silo: string, claim: ImageScanClaim) {
  if (event.type !== 'mcp.image_scan_claimed' || event.silo !== silo ||
      event.subject !== `mcp-${claim.serverId}`) return false;
  const parsed = hostedImageScanClaimedSchema.safeParse(event.data);
  return parsed.success && parsed.data.attemptId === claim.attemptId;
}

export async function claimHostedImageScan(store: EventStore, silo: string,
  rawClaim: unknown) {
  const parsed = imageScanClaimInput.safeParse(rawClaim);
  if (!parsed.success) return { status: 'unavailable' as const };
  // Give each caller its own identity even when it races with the same attempt.
  const claim = { ...parsed.data, claimToken: randomUUID() };
  const rows = await rowsFor(store, claim.serverId);
  const state = foldHostedAdmission(rows, silo, claim.serverId);
  if (!state || !matches(state, claim)) return { status: 'unavailable' as const };
  if (state.checks) return { status: 'completed' as const };
  for (const row of rows) {
    if (claimAlreadySaved(row.event, silo, claim)) {
      return { status: 'unavailable' as const };
    }
  }

  const subject = `mcp-${claim.serverId}`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, 'mcp.image_scan_claimed', claim.attemptId]));
  const event = envelope(silo, subject, 'mcp.image_scan_claimed', claim, hash.digest('hex'));
  try {
    const appended = await store.append({ event, expectedSequence: rows.at(-1)!.sequence });
    if (appended.status !== 'appended' || appended.outcome?.kind !== 'appended') {
      return { status: 'unavailable' as const };
    }
    const saved = await store.readEvent(appended.sequence);
    if (!scanClaimMatches(saved.event, silo, claim)) return { status: 'unavailable' as const };
    return { status: 'claimed' as const };
  } catch {
    // Treat a lost claim reply as claimed by another worker until history proves otherwise.
    return { status: 'unavailable' as const };
  }
}

function matchesScanEvidence(scanEvidence: unknown, result: Result, silo: string) {
  if (!hasAuthenticatedImageEvidence(scanEvidence)) return false;
  return scanEvidence.silo === silo && scanEvidence.serverId === result.serverId &&
    scanEvidence.attemptId === result.attemptId &&
    scanEvidence.imageDigest === result.imageDigest &&
    scanEvidence.platform === result.platform &&
    same(scanEvidence.malware, result.checks.malware);
}

async function currentMalwareEvidence(result: Result, silo: string, scanEvidence: unknown,
  validateEvidence: () => Promise<ValidatedMalwareEvidence>) {
  // Check the private scan after reading history, immediately before this append.
  if (!matchesScanEvidence(scanEvidence, result, silo)) return;
  let evidence: ValidatedMalwareEvidence;
  try {
    evidence = await validateEvidence();
    if (!evidence || evidence.verdict !== 'clean' || !evidence.malware ||
        !same(evidence.malware, result.checks.malware)) return;
  } catch {
    // Refuse a failed proof check before append; no event-store reply is uncertain.
    return;
  }
  const now = new Date();
  const malware = result.checks.malware;
  if (!validDates(result, now.getTime()) || malware.verdict !== 'pass') return;
  if (now.getTime() >= Date.parse(malware.expiresAt) ||
      now.getTime() >= Date.parse(malware.databaseUpdatedAt) + day) return;
  return now;
}

export async function writeHostedAdmission(store: EventStore, silo: string, raw: unknown,
  now: Date | undefined, scanEvidence: unknown,
  validateEvidence: () => Promise<ValidatedMalwareEvidence>) {
  const parsed = hostedImageCheckedSchema.safeParse(raw);
  const conflict = { status: 'conflict' as const };
  if (!parsed.success || !hasAuthenticatedImageEvidence(scanEvidence) ||
      typeof validateEvidence !== 'function') return conflict;
  const result = parsed.data;
  const rows = await rowsFor(store, result.serverId);
  now ??= new Date();
  const state = foldHostedAdmission(rows, silo, result.serverId, now);
  if (!state || !matches(state, result)) return conflict;
  if (state.checks) {
    if (same(state.checks, result.checks)) return { status: 'appended' as const };
    return conflict;
  }
  if (!validDates(result, now.getTime())) return conflict;
  const checkedNow = await currentMalwareEvidence(result, silo, scanEvidence, validateEvidence);
  if (!checkedNow) return conflict;
  const subject = `mcp-${result.serverId}`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, 'mcp.image_checked', result.attemptId]));
  const event = envelope(silo, subject, 'mcp.image_checked', result, hash.digest('hex'), now);
  const appendInput = { event, expectedSequence: rows.at(-1)!.sequence };
  const appended = await store.append(appendInput);
  if (appended.status !== 'appended') return appended;
  // Check saved bytes because simultaneous retries can reach event-store deduplication.
  const saved = await store.readEvent(appended.sequence);
  if (!same(saved.event.data, result) || !modelsResult(saved.event, silo, result.serverId)) {
    return conflict;
  }
  return { status: 'appended' as const };
}

const requestInput = hostedImageCheckRequestedSchema.omit({ serverId: true }).extend({
  commandId: z.string().regex(/^[\w-]{1,200}$/u),
});

export async function requestHostedCheck(store: EventStore, binding: Binding, memberId: string,
  serverId: string, raw: unknown) {
  const command = requestInput.parse(raw);
  const { commandId, ...fields } = command;
  const payload = { serverId, ...fields };
  // Read installation history before starting the short access check.
  const rows = await rowsFor(store, serverId);
  const state = foldHostedAdmission(rows, binding.silo, serverId);
  if (!state) {
    return { status: 'not_found' };
  }
  const valid = rows[0]!.sequence === command.registrationRevision &&
    rows.at(-1)!.sequence === command.expectedSequence &&
    eligibleRequest(state, payload, Date.now());
  const result = await saveToolCommand(store, binding, memberId, serverId,
    'mcp.image_check_requested', payload, command, rows, valid);
  if (result.status !== 'appended' || !('sequence' in result)) {
    return result;
  }
  // Check the saved event because simultaneous retries can reach store deduplication.
  const saved = await store.readEvent(result.sequence);
  const event = saved.event;
  if (event.type !== 'mcp.image_check_requested' || event.silo !== binding.silo ||
      event.subject !== `mcp-${serverId}` || event.commandId !== commandId ||
      event.principal?.kind !== 'human' || event.principal.id !== memberId ||
      !same(event.data, payload)) {
    return { status: 'conflict' };
  }
  return { status: 'appended', serverId, changeRef: `chg_${commandId}`,
    attemptId: command.attemptId, sequence: saved.sequence };
}
