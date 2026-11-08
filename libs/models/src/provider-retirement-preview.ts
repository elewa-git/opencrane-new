import { z } from 'zod';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import { providerIdSchema, providerModelIdSchema,
  assistantCreatedDataSchema, budgetCeilingSetDataSchema } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import type { ProviderState, Query } from '@opencrane/projections';
import { readActiveMember } from './member-authority.ts';
import { MemberAccessRefused } from './member-authority.ts';
import { history } from './actor.ts';
import { providerRoutinePresence } from './provider-routine-presence.ts';
import { models, reservationCents } from './state.ts';
import { ProviderConflict, ProviderRefused, providerPermission,
  providerSecretRef } from './providers.ts';
import { choiceKey, checkedHistory, inventory, providerCreation, type Choice } from './provider-bindings.ts';

const sequence = z.int().nonnegative();
type Inventory = Awaited<ReturnType<typeof inventory>>;
type WorkLimit = { remaining: number; deadline: number; incomplete: boolean };
type BudgetStatus = { configured: boolean; defaultPayer: string | undefined;
  dailyCents: number; monthlyCents: number };
type BudgetConfiguration = { defaultPayer?: string; dailyCents: number; monthlyCents: number };

function emptyBudgetConfiguration(): BudgetConfiguration {
  return { dailyCents: 0, monthlyCents: 0 };
}

function addBudgetConfiguration(summary: BudgetConfiguration, row: StoredEvent) {
  // Keep spending activity out of the review; only changed settings can alter eligibility.
  if (row.event.type !== 'budget.ceiling_set') return;
  const ceiling = budgetCeilingSetDataSchema.parse(row.event.data);
  if (ceiling.scope !== 'global') return;
  summary.monthlyCents = ceiling.ceilingCents;
  if (ceiling.dailyCeilingCents !== undefined) summary.dailyCents = ceiling.dailyCeilingCents;
  if (ceiling.defaultPayingGroupId !== undefined) {
    summary.defaultPayer = ceiling.defaultPayingGroupId;
  }
}

const previewBudget: SummaryKind<BudgetConfiguration> = {
  name: 'provider-retirement-budget', keep: 4,
  empty: emptyBudgetConfiguration, add: addBudgetConfiguration,
};
function isAssistantCreation(row: StoredEvent) {
  return row.event.type === 'assistant.created';
}

const previewChoiceSchema = z.discriminatedUnion('action', [
  z.object({ kind: z.enum(['assistant', 'silo_default']), dependantId: providerIdSchema,
    task: z.literal('chat_turn'), expectedBindingSequence: sequence,
    action: z.literal('pause') }).strict(),
  z.object({ kind: z.enum(['assistant', 'silo_default']), dependantId: providerIdSchema,
    task: z.literal('chat_turn'), expectedBindingSequence: sequence,
    action: z.literal('replace'), targetProviderId: providerIdSchema,
    targetRevision: z.int().positive(), model: providerModelIdSchema }).strict(),
]);
const previewInputSchema = z.object({ expectedProviderSequence: sequence,
  choices: z.array(previewChoiceSchema).max(200) }).strict();
type PreviewChoice = z.infer<typeof previewChoiceSchema>;

function assistantOwners(rows: StoredEvent[]) {
  const owners = new Map<string, { ownerId: string; kind: string; name: string | undefined }>();
  for (const row of rows) {
    if (!isAssistantCreation(row)) continue;
    const created = assistantCreatedDataSchema.parse(row.event.data);
    owners.set(created.assistantId, { ownerId: created.ownerId,
      kind: created.kind, name: created.name });
  }
  return owners;
}

function retirementRows(current: Inventory, assistants: StoredEvent[], providerId: string) {
  const owners = assistantOwners(assistants);
  const rows: Array<Choice & { assistantCount: number; name: string }> = [];
  for (const choice of current.bindings.values()) {
    if (choice.providerId !== providerId) continue;
    let assistantCount = choice.kind === 'assistant' ? 1 : 0;
    if (choice.kind === 'silo_default') {
      for (const assistantId of owners.keys()) {
        const own = { kind: 'assistant' as const, dependantId: assistantId, task: choice.task };
        if (!current.bindings.has(choiceKey(own))) assistantCount++;
      }
    }
    const name = choice.kind === 'assistant'
      ? owners.get(choice.dependantId)?.name ?? choice.dependantId : 'Installation default';
    rows.push({ ...choice, assistantCount, name });
  }
  function compareChoices(left: (typeof rows)[number], right: (typeof rows)[number]) {
    return choiceKey(left).localeCompare(choiceKey(right));
  }
  rows.sort(compareChoices);
  return { rows, owners };
}

function pricedModel(modelId: string) {
  function matches(candidate: (typeof models)[number]) {
    return candidate.id === modelId && !candidate.retired;
  }
  const model = models.find(matches);
  if (!model) return false;
  try {
    reservationCents(modelId, 1);
    return true;
  } catch {
    return false;
  }
}

function takeWork(limit: WorkLimit) {
  if (limit.remaining === 0 || performance.now() >= limit.deadline) {
    limit.incomplete = true;
    return false;
  }
  limit.remaining--;
  return true;
}

async function readBudgetStatus(store: EventStore, silo: string): Promise<BudgetStatus> {
  const subject = `budget-${silo}`;
  const deadline = performance.now() + 10_000;
  function take(summary: BudgetConfiguration) {
    const configured = Boolean(summary.defaultPayer) &&
      summary.dailyCents > 0 && summary.monthlyCents > 0;
    return { configured, defaultPayer: summary.defaultPayer,
      dailyCents: summary.dailyCents, monthlyCents: summary.monthlyCents };
  }
  return readStreamSummary(store, silo, subject, previewBudget, deadline, take);
}

function sameBudget(left: BudgetStatus, right: BudgetStatus) {
  return left.defaultPayer === right.defaultPayer &&
    left.dailyCents === right.dailyCents && left.monthlyCents === right.monthlyCents;
}

async function usableForOwners(binding: Binding, modelId: string,
  choice: Choice, owners: Map<string, { ownerId: string; kind: string }>,
  allBindings: Map<string, Choice>, store: EventStore, limit: WorkLimit) {
  if (choice.kind === 'assistant') {
    return usableOwner(store, binding, owners, choice.dependantId, modelId, limit);
  }
  for (const assistantId of owners.keys()) {
    const own = { kind: 'assistant' as const, dependantId: assistantId, task: choice.task };
    if (allBindings.has(choiceKey(own))) continue;
    if (!await usableOwner(store, binding, owners, assistantId, modelId, limit)) return false;
  }
  return true;
}

async function usableOwner(store: EventStore, binding: Binding,
  owners: Map<string, { ownerId: string; kind: string }>, assistantId: string,
  modelId: string, limit: WorkLimit) {
  if (!takeWork(limit)) return false;
  const owner = owners.get(assistantId);
  // A shared assistant's audience is wider than its owner. Do not guess its grants.
  if (!owner || owner.kind !== 'personal') return false;
  return ownerCanUse(store, binding, owner.ownerId, assistantId, modelId, limit.deadline);
}

async function ownerCanUse(store: EventStore, binding: Binding, ownerId: string,
  assistantId: string, modelId: string, deadline: number) {
  try {
    await readActiveMember(store, binding, ownerId);
  } catch (error) {
    if (error instanceof MemberAccessRefused) return false;
    throw error;
  }
  const subject = grantStream('model', modelId);
  const grantPosition = await store.head(subject, deadline);
  const grants = await history(store, subject, binding.silo, deadline);
  if (!directGrant(grants, 'member', ownerId) ||
    !directGrant(grants, 'assistant', assistantId)) return false;
  const auth = memberAuthorisation(binding);
  const requester = await auth.use('person', ownerId, 'model', modelId);
  const assistant = await auth.use('assistant', assistantId, 'model', modelId);
  if (requester.status !== 'ok' || assistant.status !== 'ok') {
    throw new Error('Model grants unavailable');
  }
  if (!requester.allowed || !assistant.allowed) return false;
  if (await store.head(subject, deadline) !== grantPosition) throw new ProviderConflict();
  return true;
}

function directGrant(rows: StoredEvent[], kind: string, id: string) {
  let allowed = false;
  for (const row of rows) {
    if (row.event.type !== 'grant.given' && row.event.type !== 'grant.revoked') continue;
    const data = z.object({ granteeKind: z.string().optional(),
      granteeId: z.string() }).parse(row.event.data);
    if (data.granteeId === id && (data.granteeKind === kind ||
      (row.event.type === 'grant.revoked' && data.granteeKind === undefined))) {
      allowed = row.event.type === 'grant.given';
    }
  }
  return allowed;
}

async function replacements(store: EventStore, current: Inventory, binding: Binding, memberId: string,
  providerId: string, choice: Choice, owners: Map<string, { ownerId: string; kind: string }>,
  limit: WorkLimit) {
  const available = [];
  for (const [targetProviderId, state] of current.providers) {
    if (limit.incomplete) break;
    if (targetProviderId === providerId || !readyTarget(state)) continue;
    if (!takeWork(limit)) break;
    if (!await eligibleTarget(current, binding, memberId, targetProviderId)) continue;
    for (const modelId of state.enabledModels) {
      if (!takeWork(limit)) break;
      if (!pricedModel(modelId)) continue;
      const usable = await usableForOwners(binding, modelId, choice, owners,
        current.bindings, store, limit);
      if (limit.incomplete) break;
      if (!usable) continue;
      available.push({ providerId: targetProviderId, revision: state.revision, model: modelId });
    }
  }
  return available;
}

function readyTarget(state: ProviderState) {
  return Boolean(!state.retired && state.secretRef && state.saved &&
    state.provider === 'openai' &&
    state.reachable?.outcome === 'pass' && state.reachable.revision === state.revision);
}

async function eligibleTarget(current: Inventory, binding: Binding,
  memberId: string, providerId: string) {
  function belongs(row: StoredEvent) {
    return row.event.subject === `provider-${providerId}`;
  }
  function isSavedKey(row: StoredEvent) {
    return row.event.type === 'provider.key_saved';
  }
  const rows = current.rows.filter(belongs);
  const savedKey = rows.findLast(isSavedKey);
  const state = current.providers.get(providerId);
  if (!savedKey?.event.commandId || state?.secretRef !==
    providerSecretRef(binding.silo, providerId, savedKey.event.commandId)) return false;
  try {
    await providerPermission(binding, memberId, rows);
  } catch (error) {
    if (error instanceof ProviderRefused) return false;
    throw error;
  }
  return true;
}

function matchesReplacement(input: PreviewChoice, pairs: Awaited<ReturnType<typeof replacements>>) {
  if (input.action === 'pause') return true;
  const target = input;
  function matches(pair: (typeof pairs)[number]) {
    return pair.providerId === target.targetProviderId &&
      pair.revision === target.targetRevision && pair.model === target.model;
  }
  return pairs.some(matches);
}

function validateChoices(choices: PreviewChoice[], rows: ReturnType<typeof retirementRows>['rows'],
  pairs: Map<string, Awaited<ReturnType<typeof replacements>>>) {
  if (choices.length !== rows.length) throw new ProviderConflict();
  const seen = new Set<string>();
  for (const choice of choices) {
    const key = choiceKey(choice);
    if (seen.has(key)) throw new ProviderConflict();
    seen.add(key);
    function matches(row: (typeof rows)[number]) {
      return choiceKey(row) === key;
    }
    const saved = rows.find(matches);
    if (!saved || saved.position !== choice.expectedBindingSequence ||
      !matchesReplacement(choice, pairs.get(key) ?? [])) throw new ProviderConflict();
  }
}

type RoutinePresence = Awaited<ReturnType<typeof providerRoutinePresence>>;
type PreviewSource = { assistants: string; routines: string };

function sourceStatus(providerReady: boolean, assistantReady: boolean,
  routine?: RoutinePresence) {
  const source: PreviewSource = { assistants: 'complete', routines: 'complete' };
  const blockers: string[] = [];
  if (!providerReady || !assistantReady) {
    source.assistants = 'unavailable';
    blockers.push('Could not load assistant dependencies');
  }
  if (!routine) {
    source.routines = 'unavailable';
    blockers.push('Could not load routine dependencies');
  } else if (routine.status === 'unsupported') {
    source.routines = 'not_available';
    blockers.push('Routine model bindings are not available yet');
  }
  return { source, blockers };
}

async function loadSources(store: EventStore, binding: Binding, memberId: string,
  providerId: string, db: Query) {
  const prepared = await Promise.allSettled([
    inventory(store, binding.silo),
    checkedHistory(store, binding.silo, 'assistant-*', performance.now() + 10_000),
    providerRoutinePresence(store, db, binding.silo, performance.now() + 10_000),
    providerCreation(store, binding.silo, providerId),
  ]);
  // Check current rights after loading so a late reply cannot reveal dependencies.
  await readActiveMember(store, binding, memberId, 'admin');
  const creation = prepared[3];
  if (creation?.status !== 'fulfilled') throw new Error('Provider unavailable');
  await providerPermission(binding, memberId, creation.value);
  const providerRead = prepared[0];
  const assistantRead = prepared[1];
  const routineRead = prepared[2];
  const current = providerRead?.status === 'fulfilled' ? providerRead.value : undefined;
  const assistants = assistantRead?.status === 'fulfilled' ? assistantRead.value : [];
  let routine: RoutinePresence | undefined;
  if (routineRead?.status === 'fulfilled') routine = routineRead.value;
  const { source, blockers } = sourceStatus(Boolean(current),
    assistantRead?.status === 'fulfilled', routine);
  if (!current) throw new Error('Provider dependencies unavailable');
  if (!current.providers.has(providerId)) throw new ProviderRefused();
  return { current, assistants, routine, source, blockers };
}

async function readUnresolvedRoutines(db: Query, silo: string, after: number,
  routine: RoutinePresence) {
  const result = await db.query<{ routine_id: string; name: string | null;
    position: string }>(`SELECT routine_id,
      state #>> '{definition,definition,name}' AS name, position FROM routines
      WHERE silo = $1 ORDER BY routine_id LIMIT 51 OFFSET $2`,
  [silo, after], { deadline: performance.now() + 10_000 });
  const page = result.rows.slice(0, 50);
  function routineRow(row: (typeof page)[number]) {
    return { routineId: row.routine_id, name: row.name,
      position: Number(row.position) };
  }
  const rows = page.map(routineRow);
  if (!await routine.checkCurrent(performance.now() + 10_000)) {
    throw new Error('Routine projection changed');
  }
  const nextCursor = result.rows.length > 50 ? after + 50 : null;
  return { rows, nextCursor };
}

async function collectPairs(store: EventStore, current: Inventory, binding: Binding,
  memberId: string, providerId: string,
  rows: ReturnType<typeof retirementRows>['rows'],
  owners: ReturnType<typeof assistantOwners>, limit: WorkLimit) {
  const pairs = new Map<string, Awaited<ReturnType<typeof replacements>>>();
  for (const row of rows) {
    pairs.set(choiceKey(row), await replacements(store, current, binding,
      memberId, providerId, row, owners, limit));
  }
  return pairs;
}

async function preparePairs(store: EventStore, current: Inventory, binding: Binding,
  memberId: string, providerId: string, rows: ReturnType<typeof retirementRows>['rows'],
  owners: ReturnType<typeof assistantOwners>, budget: BudgetStatus,
  source: PreviewSource, blockers: string[]) {
  if (!budget.configured || source.assistants !== 'complete') {
    return new Map<string, Awaited<ReturnType<typeof replacements>>>();
  }
  const limit: WorkLimit = { remaining: 200, deadline: performance.now() + 10_000,
    incomplete: false };
  const pairs = await collectPairs(store, current, binding, memberId,
    providerId, rows, owners, limit);
  if (limit.incomplete) {
    source.assistants = 'unavailable';
    blockers.push('Could not check every replacement');
  }
  return pairs;
}

function checkProposal(proposal: unknown, current: Inventory, source: PreviewSource,
  rows: ReturnType<typeof retirementRows>['rows'],
  pairs: Awaited<ReturnType<typeof collectPairs>>) {
  const input = previewInputSchema.parse(proposal);
  if (input.expectedProviderSequence !== current.position ||
    source.assistants !== 'complete' || source.routines !== 'complete') {
    throw new ProviderConflict();
  }
  validateChoices(input.choices, rows, pairs);
}

function checkPage(after: number, current: Inventory, routinePosition: number | null,
  expectedPositions?: { provider: number; routine: number }) {
  if (!Number.isSafeInteger(after) || after < 0) throw new ProviderConflict();
  if (after === 0) return;
  if (!expectedPositions || expectedPositions.provider !== current.position ||
    expectedPositions.routine !== routinePosition) throw new ProviderConflict();
}

async function unresolvedRoutinePage(db: Query, silo: string, after: number,
  source: PreviewSource, blockers: string[], routine?: RoutinePresence) {
  const empty = { rows: [], nextCursor: null };
  if (source.routines !== 'not_available' || !routine) return empty;
  try {
    return await readUnresolvedRoutines(db, silo, after, routine);
  } catch {
    source.routines = 'unavailable';
    blockers.push('Could not load routine dependencies');
    return empty;
  }
}

export async function providerRetirementPreview(store: EventStore, binding: Binding,
  memberId: string, providerId: string, db: Query, after = 0, proposal?: unknown,
  expectedPositions?: { provider: number; routine: number }) {
  providerIdSchema.parse(providerId);
  const prepared = await loadSources(store, binding, memberId, providerId, db);
  const { current, assistants, routine, source, blockers } = prepared;
  const budget = await readBudgetStatus(store, binding.silo);
  const routinePosition = routine?.position ?? null;
  checkPage(after, current, routinePosition, expectedPositions);
  const { rows, owners } = retirementRows(current, assistants, providerId);
  if (proposal !== undefined && rows.length > 200) throw new ProviderConflict();
  const page = rows.slice(after, after + 50);
  const candidates = proposal === undefined ? page : rows;
  const pairs = await preparePairs(store, current, binding, memberId,
    providerId, candidates, owners, budget, source, blockers);
  if (rows.length > 200) blockers.push('Too many dependencies to review at once');
  blockers.push('Retirement is not available yet');
  const unresolvedRoutines = await unresolvedRoutinePage(db, binding.silo, after,
    source, blockers, routine);
  const latestBudget = await readBudgetStatus(store, binding.silo);
  if (!sameBudget(budget, latestBudget)) {
    source.assistants = 'unavailable';
    blockers.push('Spending settings changed during the review');
  }
  if (routine && !await routine.checkCurrent(performance.now() + 10_000)) {
    source.routines = 'unavailable';
    blockers.push('Could not load routine dependencies');
  }
  if (proposal !== undefined) checkProposal(proposal, current, source, rows, pairs);
  function dependency(row: (typeof page)[number]) {
    return { ...row, replacements: pairs.get(choiceKey(row)) ?? [],
      pauseAvailable: true };
  }
  const dependencies = page.map(dependency);
  const nextCursor = after + page.length < rows.length ? after + page.length : null;
  await readActiveMember(store, binding, memberId, 'admin');
  if (await store.head('provider-*') !== current.position) throw new ProviderConflict();
  return { providerId, revision: current.providers.get(providerId)?.revision,
    expectedProviderSequence: current.position, loadedAt: new Date().toISOString(),
    sources: source, dependencies, nextCursor, total: rows.length, blockers,
    routinePosition, unresolvedRoutines: unresolvedRoutines.rows,
    routineNextCursor: unresolvedRoutines.nextCursor,
    choicesValid: proposal !== undefined, canRetire: false };
}
