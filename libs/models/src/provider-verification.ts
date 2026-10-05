import { providerIdSchema, providerModelIdSchema,
  providerDispatchedSchema } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { ProviderState } from '@opencrane/projections';
import { verifyCommand } from './budget-config.ts';
import type { JSONWebKeySet } from 'jose';
import { BudgetActor, BudgetRefused, envelope, history } from './actor.ts';
import { appendProvider, providerAuthority, providerHistory, providerReceipt,
  ProviderConflict, ProviderRefused, ProviderUnpriced, providerPermission } from './providers.ts';
import { requestReservationCents, costCents, data as eventData, models,
  priceTableId } from './state.ts';
import type { ProviderSecrets } from './provider-secrets.ts';

const providerContentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});
const providerOutputSchema = z.object({
  type: z.string(),
  content: z.array(providerContentSchema).optional(),
});
const providerTokenDetailsSchema = z.object({
  cached_tokens: z.int().nonnegative().optional(),
  cache_write_tokens: z.int().nonnegative().optional(),
});
const providerUsageSchema = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  input_tokens_details: providerTokenDetailsSchema.optional(),
});
const providerResponseSchema = z.object({
  status: z.string(),
  output: z.array(providerOutputSchema),
  usage: providerUsageSchema,
});
const providerModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});
const id = providerIdSchema;
const modelId = providerModelIdSchema;
const common = { providerId: id, commandId: id, expectedRevision: z.int().positive() };
export const providerVerificationSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.enum(['reachability', 'skip']) }).strict(),
  z.object({ ...common, action: z.literal('test'), model: modelId,
    priceTableId: id, reservedCents: z.int().positive(), consent: z.literal(true) }).strict(),
]);
type Verification = z.infer<typeof providerVerificationSchema>;
const GATEWAY_TIMEOUT_MS = 15_000;
const RETRY_MARGIN_MS = 5_000;
export interface ProviderVerificationOptions {
  secrets: ProviderSecrets;
  gatewayUrl: string;
}
function testBody(model: string) {
  return { model, input: 'Reply with OK.', max_output_tokens: 16, stream: false,
    store: false, service_tier: 'default' };
}
export function providerTestQuote(state: ProviderState, modelId: string) {
  function matches(model: (typeof models)[number]) {
    return model.id === modelId && !model.retired;
  }
  if (state.provider !== 'openai' || !state.secretRef || !models.some(matches)) {
    throw new ProviderUnpriced('Unknown or unpriced model');
  }
  const body = testBody(modelId);
  return { providerId: state.providerId, revision: state.revision, model: modelId,
    priceTableId, reservedCents: requestReservationCents(body), consentRequired: true };
}
function requestedData(input: Verification, memberId: string) {
  const base = { providerId: input.providerId, revision: input.expectedRevision,
    changedBy: memberId, attemptId: input.commandId,
    kind: input.action === 'reachability' ? 'reachability' as const : 'model' as const };
  if (input.action === 'test') {
    return { ...base, model: input.model, reservedCents: input.reservedCents };
  }
  return base;
}
async function checkRevision(store: EventStore, binding: Binding,
  memberId: string, input: Verification) {
  const fresh = await providerAuthority(store, binding, memberId);
  fresh.include(`provider-${input.providerId}`);
  const current = await providerHistory(store, binding.silo, input.providerId, fresh.deadline);
  if (!current.state?.secretRef || current.state.revision !== input.expectedRevision) {
    throw new ProviderConflict('Configuration changed');
  }
  await providerPermission(binding, memberId, current.rows);
  if (input.action === 'test') {
    const quote = providerTestQuote(current.state, input.model);
    if (quote.priceTableId !== input.priceTableId || quote.reservedCents !== input.reservedCents) {
      throw new ProviderConflict('Price changed');
    }
  }
  return { ...current, state: current.state, fresh };
}
/** One append records intent; a retry never sends the check again. */
export async function requestProviderVerification(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  const input = providerVerificationSchema.parse(raw);
  const current = await checkRevision(store, binding, memberId, input);
  const data = requestedData(input, memberId);
  let type = 'provider.verification_requested';
  let payload: unknown = data;
  if (input.action === 'skip') {
    type = 'provider.verification_recorded';
    payload = { ...data, outcome: 'skipped' };
  }
  function matches(row: (typeof current.rows)[number]) {
    return row.event.commandId === input.commandId;
  }
  const previous = current.rows.find(matches);
  if (previous) {
    if (previous.event.type !== type ||
      JSON.stringify(previous.event.data) !== JSON.stringify(payload)) {
      throw new ProviderConflict();
    }
    await current.fresh();
    return { receipt: providerReceipt(previous), created: false, input };
  }
  const receipt = await appendProvider(store, binding.silo, input.providerId, memberId,
    input.commandId, type, payload, current.rows.at(-1)?.sequence ?? 0, current.fresh);
  return { receipt, created: true, input };
}
export async function verifyProviderCapability(identity: { jwks: JSONWebKeySet; issuer: string },
  silo: string, raw: unknown, authorization?: string) {
  try {
    const checked = await verifyCommand(identity, raw, silo, authorization,
      'provider-verification');
    return checked.memberId;
  } catch {
    throw new ProviderRefused('Invalid provider capability');
  }
}
/** Gateway admission consumes the attempt before any upstream bytes are sent. */
export async function admitProviderVerification(actor: BudgetActor, binding: Binding,
  memberId: string, raw: unknown, options: ProviderVerificationOptions,
  path: string, body: string, reservationId?: string) {
  const input = providerVerificationSchema.parse(raw);
  if (input.action === 'skip') {
    throw new ProviderRefused();
  }
  const current = await checkRevision(actor.store, binding, memberId, input);
  checkGatewayRequest(input, current.state.provider, path, body);
  const data = requestedData(input, memberId);
  function matches(row: (typeof current.rows)[number]) {
    return row.event.commandId === input.commandId;
  }
  const requested = current.rows.find(matches);
  if (requested?.event.type !== 'provider.verification_requested' ||
    JSON.stringify(requested.event.data) !== JSON.stringify(data)) {
    throw new ProviderRefused();
  }
  for (const row of current.rows) {
    if ((row.event.type === 'provider.verification_dispatched' ||
      row.event.type === 'provider.verification_recorded') &&
      eventData(row.event)['attemptId'] === input.commandId) {
      throw new ProviderRefused('Attempt already consumed');
    }
  }
  checkReservation(actor, input, requested.event.id, memberId, reservationId);
  await current.fresh();
  const key = await options.secrets.read(current.state.secretRef!);
  const payload = { ...data, ...(reservationId ? { reservationId } : {}) };
  await appendProvider(actor.store, binding.silo, input.providerId, memberId,
    `internal:provider:${input.commandId}:dispatch`, 'provider.verification_dispatched', payload,
    current.rows.at(-1)?.sequence ?? 0, current.fresh);
  return key;
}
function checkGatewayRequest(input: Verification, provider: string, path: string, body: string) {
  const routeAction = input.action === 'test' ? 'test' : 'reachability';
  const expectedPath = `/authorize/providers/${provider}/${routeAction}`;
  if (path !== expectedPath) {
    throw new ProviderRefused();
  }
  if (input.action === 'test' && body !== JSON.stringify(testBody(input.model))) {
    throw new ProviderRefused('Test body changed');
  }
  if (input.action === 'reachability' && body) {
    throw new ProviderRefused();
  }
}
function checkReservation(actor: BudgetActor, input: Verification, requestedEventId: string,
  memberId: string, reservationId?: string) {
  if (input.action !== 'test') {
    if (reservationId) {
      throw new ProviderRefused();
    }
    return;
  }
  const modelId = input.model;
  const reservedCents = input.reservedCents;
  function matchesReservation(reservation: (typeof actor.state.reservations)[number]) {
    return reservation.id === reservationId && reservation.call.requestId === requestedEventId &&
      reservation.call.requesterId === memberId && reservation.call.model === modelId &&
      reservation.amountCents === reservedCents && reservation.settledCents === undefined;
  }
  if (!actor.state.reservations.some(matchesReservation)) {
    throw new ProviderRefused();
  }
}
async function recordResult(actor: BudgetActor, binding: Binding, memberId: string,
  input: Verification, outcome: 'pass' | 'fail' | 'unknown' | 'budget_refused',
  reservationId?: string, settledCents?: number) {
  // Save the result of an existing check, even after its member or settings change.
  // Grant no new access and keep the original settings revision.
  const payload = { ...requestedData(input, memberId), outcome, reservationId, settledCents };
  for (let retry = 0; retry < 3; retry++) {
    const rows = await history(actor.store, `provider-${input.providerId}`, binding.silo);
    try {
      return await appendProvider(actor.store, binding.silo, input.providerId, memberId,
        `internal:provider:${input.commandId}:result`, 'provider.verification_recorded',
        payload, rows.at(-1)?.sequence ?? 0, skipAuthorityForAdmittedAttempt);
    } catch (error) {
      if (!(error instanceof ProviderConflict)) {
        throw error;
      }
    }
  }
  throw new ProviderConflict('Result append conflicted');
}
export async function runProviderVerification(actor: BudgetActor, binding: Binding,
  memberId: string, raw: unknown, authorization: string,
  options: ProviderVerificationOptions) {
  const requested = await requestProviderVerification(actor.store, binding, memberId, raw);
  const { input, receipt } = requested;
  if (input.action === 'skip') {
    return receipt;
  }
  if (!requested.created) {
    await finishUndispatchedVerification(actor, binding, memberId, input, receipt.changeId);
    return receipt;
  }
  let reservationId: string | undefined;
  try {
    if (input.action === 'test') {
      const reservation = await reserveProviderTest(actor, binding, memberId, input,
        receipt.changeId, raw);
      reservationId = reservation.reservationId;
      await recordVerificationDecision(actor, binding.silo, receipt.changeId,
        reservationId, reservation.contextDigest);
    }
  } catch (error) {
    if (error instanceof BudgetRefused) {
      await recordResult(actor, binding, memberId, input, 'budget_refused');
      return receipt;
    }
    // The gateway has not been called, so no provider effect or allow decision is needed
    // to release the hold. Finish the attempt before returning the original refusal.
    let settledCents: number | undefined;
    if (reservationId) {
      await actor.releaseUndispatched(reservationId);
      settledCents = 0;
    }
    await recordResult(actor, binding, memberId, input, 'unknown', reservationId, settledCents);
    throw error;
  }
  const observed = await callProviderGateway(actor, binding, memberId, input,
    authorization, options, reservationId);
  await recordResult(actor, binding, memberId, input, observed.outcome,
    reservationId, observed.settledCents);
  return receipt;
}
async function finishUndispatchedVerification(actor: BudgetActor, binding: Binding,
  memberId: string, input: Verification, requestedEventId: string) {
  function matchesReservation(reservation: (typeof actor.state.reservations)[number]) {
    return reservation.call.requestId === requestedEventId;
  }
  const reservation = actor.state.reservations.find(matchesReservation);
  const payload = {
    ...requestedData(input, memberId), outcome: 'unknown',
    reservationId: reservation?.id, settledCents: reservation?.settledCents,
  };
  function matchesAttempt(row: StoredEvent) {
    return eventData(row.event)['attemptId'] === input.commandId;
  }
  function isDispatch(row: StoredEvent) {
    return row.event.type === 'provider.verification_dispatched';
  }
  function isResult(row: StoredEvent) {
    return row.event.type === 'provider.verification_recorded';
  }
  function isRequest(row: StoredEvent) {
    return row.event.id === requestedEventId;
  }
  for (let retry = 0; retry < 3; retry++) {
    const rows = await history(actor.store, `provider-${input.providerId}`, binding.silo);
    const request = rows.find(isRequest);
    const startedAt = reservation?.time ?? request?.event.time;
    if (!startedAt) {
      return;
    }
    const elapsedMs = actor.now().getTime() - Date.parse(startedAt);
    // Leave time for the first check to finish before a retry closes its attempt.
    if (elapsedMs <= GATEWAY_TIMEOUT_MS + RETRY_MARGIN_MS) {
      return;
    }
    const attempt = rows.filter(matchesAttempt);
    if (attempt.some(isDispatch)) {
      return;
    }
    if (!attempt.some(isResult)) {
      try {
        // Finish on the same provider stream as dispatch, so only one can be saved.
        // Prevent gateway admission from releasing the key after the attempt finishes.
        await appendProvider(actor.store, binding.silo, input.providerId, memberId,
          `internal:provider:${input.commandId}:result`, 'provider.verification_recorded',
          payload, rows.at(-1)?.sequence ?? 0, skipAuthorityForAdmittedAttempt);
      } catch (error) {
        if (error instanceof ProviderConflict) {
          continue;
        }
        throw error;
      }
    }
    return;
  }
  throw new ProviderConflict('Result append conflicted');
}
// Record only the outcome of an existing attempt, without granting new access.
// Check access before accepting a retry; keep results even after access changes.
function skipAuthorityForAdmittedAttempt() {
  return Promise.resolve();
}
async function reserveProviderTest(actor: BudgetActor, binding: Binding, memberId: string,
  input: Extract<Verification, { action: 'test' }>, requestedEventId: string, raw: unknown) {
  const current = await checkRevision(actor.store, binding, memberId, input);
  const payingGroupId = actor.state.defaultPayingGroupId;
  if (!payingGroupId) {
    throw new ProviderRefused('Paying group unavailable');
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify(raw));
  const contextDigest = hash.digest('hex');
  const call = { requestId: requestedEventId, model: input.model, priceTableId,
    computerId: `provider-${input.providerId}`, assistantId: 'provider-verification',
    requesterId: memberId, conversationId: `provider-${input.providerId}`,
    turnId: input.commandId, threadId: input.commandId, payingGroupId, contextDigest };
  const reservationId = await actor.reserve(call, input.reservedCents, current.fresh);
  return { reservationId, contextDigest };
}
async function recordVerificationDecision(actor: BudgetActor, silo: string,
  requestedEventId: string, reservationId: string, contextDigest: string) {
  const payload = { requestId: requestedEventId, route: 'model', outcome: 'allow',
    reason: 'provider_verification', contextDigest, permitId: reservationId };
  const audit = envelope(silo, `decision-${requestedEventId}`, 'decision.recorded', payload);
  const command = { event: audit, expectedSequence: 0 };
  const result = await actor.store.append(command);
  if (result.status !== 'appended') {
    throw new Error('Verification audit unavailable');
  }
}
// Only a reply that lists the provider's models passes. Any other reply is unclear:
// it does not prove the key was rejected, so we record unknown, not fail.
function reachabilityOutcome(body: unknown): 'pass' | 'unknown' {
  if (providerModelListSchema.safeParse(body).success) {
    return 'pass';
  }
  return 'unknown';
}
async function callProviderGateway(actor: BudgetActor, binding: Binding, memberId: string,
  input: Verification, authorization: string, options: ProviderVerificationOptions,
  reservationId?: string
): Promise<{ outcome: 'pass' | 'fail' | 'unknown'; settledCents?: number }> {
  let response: Response;
  let body: unknown;
  try {
    const current = await checkRevision(actor.store, binding, memberId, input);
    await current.fresh();
    const action = input.action === 'reachability' ? 'reachability' : 'test';
    const headers: Record<string, string> = { 'x-provider-token': authorization,
      'x-provider-command': Buffer.from(JSON.stringify(input)).toString('base64url'),
      'content-type': 'application/json' };
    if (reservationId) {
      headers['x-provider-reservation'] = reservationId;
    }
    // Never follow a redirect. The redirect target is not the provider, and following it
    // would send our check token and the request body to another server.
    const request: RequestInit = { method: 'GET', headers, redirect: 'manual',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) };
    if (input.action === 'test') {
      const body = testBody(input.model);
      request.method = 'POST';
      request.body = JSON.stringify(body);
    }
    const url = `${options.gatewayUrl}/providers/${current.state.provider}/${action}`;
    response = await fetch(url, request);
    if (!response.ok) {
      return gatewayFailure(actor, binding.silo, input, reservationId, response.status);
    }
    body = await response.json();
  } catch {
    return gatewayFailure(actor, binding.silo, input, reservationId);
  }
  if (input.action === 'reachability') {
    return { outcome: reachabilityOutcome(body) };
  }
  if (!reservationId || input.action !== 'test') {
    throw new ProviderRefused();
  }
  return settleProviderResponse(actor, binding.silo, input.model, reservationId, body);
}
async function gatewayFailure(actor: BudgetActor, silo: string, input: Verification,
  reservationId?: string, responseStatus?: number
): Promise<{ outcome: 'fail' | 'unknown'; settledCents?: number }> {
  const rows = await history(actor.store, `provider-${input.providerId}`, silo);
  function dispatchedAttempt(row: (typeof rows)[number]) {
    if (row.event.type !== 'provider.verification_dispatched') {
      return false;
    }
    return providerDispatchedSchema.parse(row.event.data).attemptId ===
      input.commandId;
  }
  const dispatched = rows.some(dispatchedAttempt);
  const keyRejected = responseStatus === 401 || responseStatus === 403;
  const definiteRejection = keyRejected || responseStatus === 429;
  if (reservationId) {
    if (!dispatched) {
      // The gateway never released the key, so no provider cost can exist.
      await actor.releaseUndispatched(reservationId);
      return { outcome: 'unknown', settledCents: 0 };
    }
    if (definiteRejection) {
      await actor.effect(reservationId, undefined, 'error');
      await settleRecordedProviderEffect(actor, silo, reservationId);
      return { outcome: 'fail', settledCents: 0 };
    }
    // Admission may finish after the gateway gives up, so a stored dispatch alone
    // cannot distinguish a gateway outage from an upstream call with unknown cost.
    await actor.uncertain(reservationId, 'transport_failure');
  }
  if (dispatched && keyRejected && input.action === 'reachability') {
    return { outcome: 'fail' };
  }
  return { outcome: 'unknown' };
}
async function settleProviderResponse(actor: BudgetActor, silo: string, model: string,
  reservationId: string, body: unknown): Promise<{
    outcome: 'pass' | 'fail' | 'unknown'; settledCents?: number;
  }> {
  const responseBody = providerResponseSchema.safeParse(body);
  if (!responseBody.success) {
    await actor.uncertain(reservationId, 'missing_usage');
    return { outcome: 'unknown' };
  }
  const answer = responseBody.data;
  function hasText(content: NonNullable<(typeof answer.output)[number]['content']>[number]) {
    return content.type === 'output_text' && Boolean(content.text?.trim());
  }
  function isAnswer(item: (typeof answer.output)[number]) {
    return item.type === 'message' && Boolean(item.content?.some(hasText));
  }
  const answered = answer.status === 'completed' && answer.output.some(isAnswer);
  const usage = { inputTokens: answer.usage.input_tokens,
    outputTokens: answer.usage.output_tokens,
    cachedInputTokens: answer.usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: answer.usage.input_tokens_details?.cache_write_tokens ?? 0 };
  await actor.effect(reservationId, usage);
  await settleRecordedProviderEffect(actor, silo, reservationId);
  return { outcome: answered ? 'pass' : 'fail', settledCents: costCents(model,
    usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens) };
}
async function settleRecordedProviderEffect(actor: BudgetActor, silo: string,
  reservationId: string) {
  const rows = await history(actor.store, `effect-${reservationId}`, silo);
  const observed = rows.at(-1);
  if (!observed || observed.event.type !== 'effect.observed') {
    throw new Error('Usage unavailable');
  }
  await actor.settleRecorded(reservationId, observed.event.id);
}
