import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation, grantStream } from '@opencrane/authz';
import { computerSummary } from '@opencrane/auth';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema }
  from '@opencrane/events';
import { authorityFence, history, groupMembership, modelForTask,
  priceTableId, providerTurnAdmission, readActiveMember, reservationCents,
  readToolPolicy, decisionProvider, RootBudgetRefused,
  MemberAccessRefused, PayingGroupRefused, type BudgetActor,
  type ProviderSecrets } from '@opencrane/models';
import type { MemoryOptions } from './access.ts';
import { readAssistant, MemoryRefused } from './access.ts';

type Binding = z.infer<typeof memoryMaintenanceBoundDataSchema>;
type Intent = z.infer<typeof memoryMaintenanceRecordedDataSchema>;
type AccessKind = 'model' | 'mcp_server' | 'memory_read' | 'memory_write';
const readyComputer = z.object({ assistantId: z.string(), computerId: z.string(),
  generation: z.int().positive() });
const grantFields = z.object({ granteeKind: z.string().optional(),
  granteeId: z.string(), resourceType: z.string(), resourceId: z.string() });

export type MaintenanceAdmission = { actor: BudgetActor; secrets: ProviderSecrets | undefined;
  managedCalls: boolean;
  qualification: (silo: string) => Promise<{ confirm: () => void }> };
export class MaintenanceRootRefused extends Error {
  readonly reason: 'provider_unavailable' | 'access_denied' |
    'access_unavailable' | 'budget_unavailable' | 'price_unavailable';
  constructor(reason: MaintenanceRootRefused['reason']) {
    super('Maintenance root refused');
    this.reason = reason;
  }
}

function lastPosition(rows: StoredEvent[]): number {
  return rows.at(-1)?.sequence ?? 0;
}

function latestGrant(rows: StoredEvent[], kind: 'member' | 'assistant', id: string,
  resourceType: string, resourceId: string) {
  let active: StoredEvent | undefined;
  for (const row of rows) {
    const data = grantFields.parse(row.event.data);
    if (data.resourceType !== resourceType || data.resourceId !== resourceId ||
        row.event.subject !== grantStream(resourceType, resourceId)) {
      throw new MaintenanceRootRefused('access_unavailable');
    }
    if (data.granteeId !== id ||
        (data.granteeKind !== undefined && data.granteeKind !== kind)) {
      continue;
    }
    if (row.event.type === 'grant.given' && data.granteeKind === kind) {
      active = row;
    }
    if (row.event.type === 'grant.revoked') {
      active = undefined;
    }
  }
  return active;
}

async function requireGrant(options: MemoryOptions, requester: string, assistantId: string,
  kind: AccessKind, resourceId: string, rows: StoredEvent[]) {
  const member = latestGrant(rows, 'member', requester, kind, resourceId);
  const assistant = latestGrant(rows, 'assistant', assistantId, kind, resourceId);
  if (!member || !assistant) throw new MaintenanceRootRefused('access_denied');
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(member.event.id) || !await auth.applied(assistant.event.id)) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const memberUse = await auth.use('person', requester, kind, resourceId);
  const assistantUse = await auth.use('assistant', assistantId, kind, resourceId);
  if (memberUse.status === 'unavailable' || assistantUse.status === 'unavailable') {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  if (!memberUse.allowed || !assistantUse.allowed) {
    throw new MaintenanceRootRefused('access_denied');
  }
}

async function requireAssistantAccess(options: MemoryOptions, binding: Binding) {
  const requester = binding.memberId;
  const assistantId = binding.assistantId;
  const assistant = await readAssistant(options, assistantId);
  if (assistant.assistant.ownerId !== requester || assistant.assistant.kind !== 'personal' ||
      (assistant.assistant.payingGroupId &&
        assistant.assistant.payingGroupId !== binding.payingGroupId)) {
    throw new MaintenanceRootRefused('access_denied');
  }
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(assistant.created.id)) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const acting = await auth.actsFor(requester, assistantId);
  if (acting.status === 'unavailable') {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  if (!acting.allowed) throw new MaintenanceRootRefused('access_denied');
}

async function accessPreparation(options: MemoryOptions, binding: Binding, model: string) {
  const requester = binding.memberId;
  const assistantId = binding.assistantId;
  if (binding.scopeKind !== 'person' || binding.ownerId !== requester) {
    throw new MaintenanceRootRefused('access_denied');
  }
  const subjects = [`member-${requester}`, `assistant-${assistantId}`,
    `team-${binding.payingGroupId}`, grantStream('model', model),
    grantStream('mcp_server', 'memory'),
    grantStream('memory_read', binding.scopeId),
    grantStream('memory_write', binding.scopeId)];
  const deadline = performance.now() + 10_000;
  function readSubject(subject: string) {
    return history(options.store, subject, options.silo, deadline);
  }
  const reads = subjects.map(readSubject);
  const histories = await Promise.all(reads);
  const positions = new Map<string, number>();
  for (let index = 0; index < subjects.length; index++) {
    positions.set(subjects[index]!, lastPosition(histories[index]!));
  }
  try {
    await readActiveMember(options.store, options.binding, requester);
    await groupMembership(options.store, options.silo, requester,
      binding.payingGroupId, options.binding, deadline);
    await requireAssistantAccess(options, binding);
    await requireGrant(options, requester, assistantId, 'model', model, histories[3]!);
    await requireGrant(options, requester, assistantId, 'mcp_server', 'memory', histories[4]!);
    await requireGrant(options, requester, assistantId,
      'memory_read', binding.scopeId, histories[5]!);
    await requireGrant(options, requester, assistantId,
      'memory_write', binding.scopeId, histories[6]!);
  } catch (error) {
    if (error instanceof MaintenanceRootRefused) throw error;
    if (error instanceof MemberAccessRefused || error instanceof PayingGroupRefused ||
        error instanceof MemoryRefused) {
      throw new MaintenanceRootRefused('access_denied');
    }
    throw new MaintenanceRootRefused('access_unavailable');
  }
  try {
    const fresh = await authorityFence(options.store, performance.now(), subjects,
      Infinity, positions);
    await fresh();
    return fresh;
  } catch {
    throw new MaintenanceRootRefused('access_unavailable');
  }
}

async function computerChoice(options: MemoryOptions, assistantId: string) {
  const deadline = performance.now() + 10_000;
  function takeComputer(summary: ReturnType<typeof computerSummary.empty>, sequence: number) {
    return { lifecycle: summary.lifecycle, control: summary.control, sequence };
  }
  const computer = await readStreamSummary(options.store, options.silo,
    `computer-${assistantId}`, computerSummary, deadline, takeComputer);
  const ready = readyComputer.safeParse(computer.lifecycle?.event.data);
  if (computer.lifecycle?.event.type !== 'computer.ready' || computer.control ||
      !ready.success || ready.data.assistantId !== assistantId) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  return { ...ready.data, sequence: computer.sequence };
}

async function selectedProvider(options: MemoryOptions, binding: Binding,
  secrets: ProviderSecrets | undefined) {
  const selected = await providerTurnAdmission(options.store, options.silo,
    binding.assistantId, performance.now() + 10_000);
  const choice = selected.choice;
  const model = modelForTask('frequent_automation');
  if (!selected.enabled || selected.draining || !choice || choice.state !== 'active') {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  let firstCallBoundCents: number;
  try {
    firstCallBoundCents = reservationCents(choice.model, 2000, 32_768);
  } catch {
    throw new MaintenanceRootRefused('price_unavailable');
  }
  if (choice.model !== model) {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  let provider: Awaited<ReturnType<typeof decisionProvider>>;
  const providerSubject = `provider-${choice.providerId}`;
  const providerPosition = await options.store.head(providerSubject,
    performance.now() + 10_000);
  try {
    provider = await decisionProvider(options.store, options.silo,
      choice, performance.now() + 10_000, providerPosition);
    await provider.credential(secrets, performance.now() + 10_000);
  } catch {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  return { choice, model, provider, providerSubject, providerPosition,
    firstCallBoundCents };
}

async function correctionPolicy(options: MemoryOptions) {
  const policySubject = 'mcp-memory';
  const policyPosition = await options.store.head(policySubject,
    performance.now() + 10_000);
  let policy: Awaited<ReturnType<typeof readToolPolicy>>;
  try {
    policy = await readToolPolicy(options.store, options.silo, 'memory',
      performance.now() + 10_000);
  } catch {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  function allowsCorrection(tool: typeof policy.tools[number]) {
    return tool.name === 'correct' && tool.reviewed && tool.mode === 'allow' &&
      tool.costCents === 0;
  }
  if (!policy.published || !policy.tools.some(allowsCorrection)) {
    throw new MaintenanceRootRefused('access_denied');
  }
  return { policySubject, policyPosition };
}

function rootBinding(options: MemoryOptions, intent: Intent, binding: Binding,
  computer: Awaited<ReturnType<typeof computerChoice>>,
  route: Awaited<ReturnType<typeof selectedProvider>>) {
  const { model, choice } = route;
  const identity = [options.silo, intent.scopeId, intent.nightId, intent.batchKey];
  const conversationId = digestIdentity([...identity, 'session']);
  const turnId = digestIdentity([...identity, 'turn']);
  const threadId = digestIdentity([...identity, 'thread']);
  const maintenance = { scopeId: intent.scopeId, nightId: intent.nightId,
    batchKey: intent.batchKey, inputRevision: intent.inputRevision,
    task: 'frequent_automation' as const, model, providerId: choice.providerId,
    bindingSequence: choice.bindingSequence, priceTableId };
  const root = { requesterId: binding.memberId, assistantId: binding.assistantId,
    payingGroupId: binding.payingGroupId, conversationId, turnId, threadId,
    computerId: computer.computerId, generation: computer.generation,
    allowanceCents: 100, maintenance };
  return { root, firstCallBoundCents: route.firstCallBoundCents };
}

async function confirmRootEvidence(options: MemoryOptions, intent: Intent, binding: Binding,
  scopePosition: number, fresh: Awaited<ReturnType<typeof authorityFence>>,
  route: Awaited<ReturnType<typeof selectedProvider>>,
  policy: Awaited<ReturnType<typeof correctionPolicy>>,
  computer: Awaited<ReturnType<typeof computerChoice>>,
  qualification: { confirm: () => void }) {
  try {
    qualification.confirm();
  } catch {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  try {
    await fresh();
  } catch {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const currentPolicyPosition = await options.store.head(policy.policySubject, fresh.deadline);
  if (currentPolicyPosition !== policy.policyPosition) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const current = await providerTurnAdmission(options.store, options.silo,
    binding.assistantId, fresh.deadline);
  if (!isDeepStrictEqual(current.choice, route.choice) || !current.enabled || current.draining) {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  try {
    await route.provider.confirm(fresh.deadline);
  } catch {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  const currentProviderPosition = await options.store.head(route.providerSubject, fresh.deadline);
  if (currentProviderPosition !== route.providerPosition) {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  const computerPosition = await options.store.head(`computer-${binding.assistantId}`,
    fresh.deadline);
  if (computerPosition !== computer.sequence) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const currentScopePosition = await options.store.head(`scope-${intent.scopeId}`,
    fresh.deadline);
  if (currentScopePosition !== scopePosition) {
    throw new MaintenanceRootRefused('access_unavailable');
  }
}

export async function admitMaintenanceRoot(options: MemoryOptions, intent: Intent,
  binding: Binding, scopePosition: number, admission: MaintenanceAdmission) {
  const { actor, secrets } = admission;
  if (actor.store !== options.store || actor.silo !== options.silo ||
      binding.acceptedCapCents !== 100 || intent.acceptedCapCents !== 100) {
    throw new MaintenanceRootRefused('budget_unavailable');
  }
  if (!admission.managedCalls) {
    throw new MaintenanceRootRefused('provider_unavailable');
  }
  const route = await selectedProvider(options, binding, secrets);
  const computer = await computerChoice(options, binding.assistantId);
  const policy = await correctionPolicy(options);
  let qualification: { confirm: () => void };
  try {
    qualification = await admission.qualification(options.silo);
  } catch {
    throw new MaintenanceRootRefused('access_unavailable');
  }
  const fresh = await accessPreparation(options, binding, route.model);
  const { root, firstCallBoundCents } = rootBinding(options, intent, binding, computer, route);
  async function confirm() {
    await confirmRootEvidence(options, intent, binding, scopePosition, fresh,
      route, policy, computer, qualification);
  }
  try {
    const saved = await actor.setRootAllowance(root, firstCallBoundCents, confirm, fresh.deadline);
    return { rootId: saved.rootId, model: route.model, providerId: route.choice.providerId,
      allowanceCents: saved.allowanceCents };
  } catch (error) {
    if (error instanceof MaintenanceRootRefused) throw error;
    if (error instanceof RootBudgetRefused) {
      throw new MaintenanceRootRefused('budget_unavailable');
    }
    throw error;
  }
}

function digestIdentity(fields: string[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(fields));
  return hash.digest('hex');
}
