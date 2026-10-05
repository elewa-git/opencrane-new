import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { providerRequestedSchema } from '@opencrane/events';
import type { ProviderState } from '@opencrane/projections';
import { tokenVerifier } from '@opencrane/auth';
import type { JSONWebKeySet } from 'jose';
import { BudgetActor, BudgetRefused, envelope, history } from './actor.ts';
import { appendProvider, providerAuthority, providerHistory, providerReceipt,
  ProviderConflict, ProviderRefused, ProviderUnpriced, providerPermission } from './providers.ts';
import { requestReservationCents, costCents, models, priceTableId } from './state.ts';
import type { ProviderSecrets } from './provider-secrets.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const modelId = z.string().regex(/^[\w.-]{1,200}$/u);
const common = { providerId: id, commandId: id, expectedRevision: z.int().positive() };
export const providerVerificationSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.enum(['reachability', 'skip']) }).strict(),
  z.object({ ...common, action: z.literal('test'), model: modelId,
    priceTableId: id, reservedCents: z.int().positive(), consent: z.literal(true) }).strict(),
]);
type Verification = z.infer<typeof providerVerificationSchema>;
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
/** One append records intent; a retry only reads the original attempt. */
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
  const claims = z.object({ typ: z.literal('budget-admin'), silo: id, memberId: id,
    commandDigest: z.string() });
  try {
    const verifier = tokenVerifier(identity.jwks, identity.issuer);
    const token = authorization?.replace(/^Bearer /u, '') ?? '';
    const checked = claims.parse(await verifier.verify(token, 'budget-admin'));
    const hash = createHash('sha256');
    hash.update(JSON.stringify(raw));
    const digest = hash.digest('hex');
    if (checked.silo !== silo || checked.commandDigest !== digest) {
      throw new ProviderRefused();
    }
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
  const key = await options.secrets.read(current.state.secretRef!);
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
    if (row.event.type === 'provider.verification_dispatched' &&
      providerRequestedSchema.passthrough().parse(row.event.data).attemptId === input.commandId) {
      throw new ProviderRefused('Attempt already consumed');
    }
  }
  checkReservation(actor, input, requested.event.id, memberId, reservationId);
  const payload = { ...data, ...(reservationId ? { reservationId } : {}) };
  await appendProvider(actor.store, binding.silo, input.providerId, memberId,
    `${input.commandId}-dispatch`, 'provider.verification_dispatched', payload,
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
  const current = await checkRevision(actor.store, binding, memberId, input);
  const payload = { ...requestedData(input, memberId), outcome,
    ...(reservationId ? { reservationId } : {}),
    ...(settledCents === undefined ? {} : { settledCents }) };
  return appendProvider(actor.store, binding.silo, input.providerId, memberId,
    `${input.commandId}-result`, 'provider.verification_recorded', payload,
    current.rows.at(-1)?.sequence ?? 0, current.fresh);
}
export async function runProviderVerification(actor: BudgetActor, binding: Binding,
  memberId: string, raw: unknown, authorization: string,
  options: ProviderVerificationOptions) {
  const requested = await requestProviderVerification(actor.store, binding, memberId, raw);
  const { input, receipt } = requested;
  if (!requested.created || input.action === 'skip') {
    return receipt;
  }
  let reservationId: string | undefined;
  if (input.action === 'test') {
    const current = await checkRevision(actor.store, binding, memberId, input);
    const payingGroupId = actor.state.defaultPayingGroupId;
    if (!payingGroupId) {
      throw new ProviderRefused('Paying group unavailable');
    }
    const hash = createHash('sha256');
    hash.update(JSON.stringify(raw));
    const contextDigest = hash.digest('hex');
    const call = { requestId: receipt.changeId, model: input.model, priceTableId,
      computerId: `provider-${input.providerId}`, assistantId: 'provider-verification',
      requesterId: memberId, conversationId: input.providerId, turnId: input.commandId,
      threadId: input.commandId, payingGroupId, contextDigest };
    try {
      reservationId = await actor.reserve(call, input.reservedCents, current.fresh);
    } catch (error) {
      if (!(error instanceof BudgetRefused)) {
        throw error;
      }
      await recordResult(actor, binding, memberId, input, 'budget_refused');
      return receipt;
    }
    const audit = envelope(binding.silo, `decision-${receipt.changeId}`, 'decision.recorded',
      { requestId: receipt.changeId, route: 'model', outcome: 'allow',
        reason: 'provider_verification', contextDigest, permitId: reservationId });
    const result = await actor.store.append({ event: audit, expectedSequence: 0 });
    if (result.status !== 'appended') {
      throw new Error('Verification audit unavailable');
    }
  }
  const observed = await callProviderGateway(actor, binding, memberId, input,
    authorization, options, reservationId);
  await recordResult(actor, binding, memberId, input, observed.outcome,
    reservationId, observed.settledCents);
  return receipt;
}
async function callProviderGateway(actor: BudgetActor, binding: Binding, memberId: string,
  input: Verification, authorization: string, options: ProviderVerificationOptions,
  reservationId?: string): Promise<{ outcome: 'pass' | 'fail' | 'unknown'; settledCents?: number }> {
  const current = await checkRevision(actor.store, binding, memberId, input);
  await current.fresh();
  const action = input.action === 'reachability' ? 'reachability' : 'test';
  const headers = { 'x-provider-token': authorization,
    'x-provider-command': Buffer.from(JSON.stringify(input)).toString('base64url'),
    'content-type': 'application/json',
    ...(reservationId ? { 'x-provider-reservation': reservationId } : {}) };
  const request = { method: input.action === 'test' ? 'POST' : 'GET', headers,
    ...(input.action === 'test' ? { body: JSON.stringify(testBody(input.model)) } : {}),
    signal: AbortSignal.timeout(15_000) };
  let response: Response;
  try {
    response = await fetch(`${options.gatewayUrl}/providers/${current.state.provider}/${action}`, request);
  } catch {
    if (reservationId) {
      await actor.uncertain(reservationId, 'transport_failure');
    }
    return { outcome: 'unknown' };
  }
  if (!response.ok) {
    if (reservationId) {
      await actor.uncertain(reservationId, 'transport_failure');
    }
    return { outcome: reservationId ? 'unknown' : 'fail' };
  }
  const body: unknown = await response.json();
  if (input.action === 'reachability') {
    const modelList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
    return { outcome: modelList.safeParse(body).success ? 'pass' : 'fail' };
  }
  if (!reservationId || input.action !== 'test') {
    throw new ProviderRefused();
  }
  return settleProviderResponse(actor, binding.silo, input.model, reservationId, body);
}
async function settleProviderResponse(actor: BudgetActor, silo: string, model: string,
  reservationId: string, body: unknown): Promise<{
    outcome: 'pass' | 'fail' | 'unknown'; settledCents?: number;
  }> {
  const responseBody = z.object({ status: z.string(), output: z.array(z.object({
    type: z.string(), content: z.array(z.object({ type: z.string(),
      text: z.string().optional() })).optional(),
  })), usage: z.object({ input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(), input_tokens_details: z.object({
      cached_tokens: z.int().nonnegative().optional(),
      cache_write_tokens: z.int().nonnegative().optional(),
    }).optional() }) }).safeParse(body);
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
  const rows = await history(actor.store, `effect-${reservationId}`, silo);
  const observed = rows.at(-1);
  if (!observed || observed.event.type !== 'effect.observed') {
    throw new Error('Usage unavailable');
  }
  await actor.settleRecorded(reservationId, observed.event.id);
  return { outcome: answered ? 'pass' : 'fail', settledCents: costCents(model,
    usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens) };
}
