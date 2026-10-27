import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { connectionOAuthExchangeClaimedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { connectionOperationId } from './bearer-connections.ts';
import type { connectionCustody } from './connection-custody.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { oauthConsentUrl } from './oauth-attempt.ts';
import { checkPersonalOAuthStart, inputSchema, sessionSchema } from './oauth-start.ts';

const liveClaims = new WeakMap<object, LiveClaim>();
type LiveClaim = { status: 'claimed'; claimId: string; sequence: number; workerId: string };

/** Consume the original in-memory result once. Event readback alone cannot grant a send. */
export function takePersonalOAuthClaim(raw: unknown): LiveClaim | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const claim = liveClaims.get(raw);
  liveClaims.delete(raw);
  return claim;
}

const callbackSchema = inputSchema.extend({ redirectUri: z.string().max(2048),
  parameters: z.instanceof(URLSearchParams) });
const parametersSchema = z.strictObject({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  code: z.string().regex(/^[\x21-\x7e]{1,4096}$/u), iss: z.string().max(2048) });
type Custody = Pick<ReturnType<typeof connectionCustody>,
  'prepareAttempt' | 'readAttempt' | 'stage'>;
type SavedStart = Awaited<ReturnType<typeof checkPersonalOAuthStart>>;

function callbackParameters(parameters: URLSearchParams) {
  const names = new Set<string>();
  for (const name of parameters.keys()) {
    if (names.has(name)) {
      throw new Error('OAuth callback refused');
    }
    names.add(name);
  }
  return parametersSchema.parse(Object.fromEntries(parameters));
}

/** Accept trusted session and configuration from server code. No public route calls this. */
export async function claimPersonalOAuthCallback(store: EventStore, binding: Binding,
  rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: (serverId: string) => Promise<unknown>, db: Pick<Db, 'lock'>) {
  try {
    const session = sessionSchema.parse(rawSession);
    const input = callbackSchema.parse(raw);
    const parameters = callbackParameters(input.parameters);
    if (session.siloId !== binding.silo || session.userId !== input.userId) {
      throw new Error('OAuth callback refused');
    }
    const profile = { ...input, siloId: session.siloId };
    const subject = `connection-${session.userId}-${input.serverId}-${input.profileId}`;
    // Generate this identity here so another invocation or restarted worker cannot inherit it.
    const workerId = randomUUID();
    async function claim() {
      const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
      if (rows.length !== 1 || rows[0]!.event.type !== 'connection.oauth_started') {
        throw new Error('OAuth callback refused');
      }
      const command = inputSchema.parse({ userId: input.userId, serverId: input.serverId,
        connectionId: input.connectionId, profileId: input.profileId,
        changeRef: input.changeRef, expectedSequence: input.expectedSequence });
      const saved = await checkPersonalOAuthStart(store, binding, session, custody,
        command, loadConfiguration);
      await validateCallback(custody, saved, input.redirectUri, parameters);
      const staged = await stageCode(custody, saved, parameters.code);
      const checked = await saved.checkCurrent(saved.original!.sequence);
      const data = connectionOAuthExchangeClaimedDataSchema.parse({ userId: session.userId,
        serverId: input.serverId, connectionId: input.connectionId, profile: input.profileId,
        attemptId: saved.prepared.stage.operationId, workerId, purpose: 'consent',
        secretRef: `secret:${staged.identity.reference}`, uid: staged.identity.uid,
        resourceVersion: staged.identity.resourceVersion, expectedSequence: saved.original!.sequence,
        appendUntil: saved.prepared.stage.appendUntil });
      const event = { ...envelope(binding.silo, subject, 'connection.oauth_exchange_claimed',
        data, staged.stage.operationId), commandId: staged.stage.operationId,
        source: 'opencrane-server', principal: { kind: 'human' as const, id: session.userId } };
      const sequence = await appendClaim(store, event, checked);
      return { saved, sequence, claimId: event.id, staged };
    }
    const result = await withConnectionStage(db, profile, claim);
    // Finish private reads and lock release before deciding whether this live worker may continue.
    await validateCallback(custody, result.saved, input.redirectUri, parameters);
    const contents = await custody.readAttempt(result.staged.stage, result.staged.identity);
    if (contents !== JSON.stringify({ code: parameters.code })) {
      throw new Error('OAuth callback refused');
    }
    await result.saved.checkCurrent(result.sequence);
    if (Date.now() >= result.saved.expiresAt) {
      throw new Error('OAuth callback expired');
    }
    const live = Object.freeze({ status: 'claimed' as const, claimId: result.claimId,
      sequence: result.sequence, workerId });
    liveClaims.set(live, live);
    return live;
  } catch {
    // Hide callback values and dependency errors, including private storage responses.
    return { status: 'unknown' as const };
  }
}

async function validateCallback(custody: Custody, saved: SavedStart, redirectUri: string,
  parameters: z.infer<typeof parametersSchema>) {
  const contents = await custody.readAttempt(saved.prepared.stage, saved.prepared.identity);
  if (contents === undefined || redirectUri !== saved.configuration.redirectUri ||
      parameters.iss !== saved.configuration.issuer) {
    throw new Error('OAuth callback refused');
  }
  // Reuse the S256 and state checks against the exact private material and saved start.
  const consent = new URL(oauthConsentUrl(saved.configuration, saved.prepared, contents));
  if (parameters.state !== consent.searchParams.get('state')) {
    throw new Error('OAuth callback refused');
  }
}

async function stageCode(custody: Custody, saved: SavedStart, code: string) {
  const original = saved.prepared.stage;
  const operationId = connectionOperationId(original.siloId,
    saved.event.subject, `${original.operationId}-exchange`);
  const stage = { ...original, operationId, attemptId: operationId,
    expectedSequence: saved.original!.sequence };
  const staged = await custody.stage(stage, JSON.stringify({ code }));
  if (!staged.identity || !['staged', 'recovered'].includes(staged.status)) {
    throw new Error('OAuth callback refused');
  }
  return { stage, identity: staged.identity };
}

/** Append only. Resolve a lost reply for this invocation, never for a new worker. */
async function appendClaim(store: EventStore, event: EventEnvelope,
  checked: Awaited<ReturnType<SavedStart['checkCurrent']>>) {
  const command = { event, expectedSequence: checked.categorySequence,
    expectedSubject: 'connection-*', historyChecked: true as const,
    deadline: checked.deadline, checkAccess: checked.checkAccess };
  await store.append(command);
  const rows = await history(store, event.subject, event.silo, performance.now() + 10_000);
  const saved = rows.at(-1);
  if (!saved || !isDeepStrictEqual(saved.event, event)) {
    throw new Error('OAuth claim unconfirmed');
  }
  return saved.sequence;
}
