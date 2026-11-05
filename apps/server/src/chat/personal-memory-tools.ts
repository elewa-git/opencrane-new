import { z } from 'zod';
import { memoryScopeId } from '@opencrane/projections';
import { readDeploymentQualification } from
  '../../../../scripts/private-memory-qualification/deployment.ts';
import { readChatFacts } from './chat-summary.ts';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { grantGivenDataSchema, grantRevokedDataSchema } from '@opencrane/events';
import { approvalActivity, confirmDecisionAccess, decisionAuthorityFence,
  currentMembership, history, LoadedMemoryRefused, MemberAccessRefused,
  readToolPolicy } from '@opencrane/models';
import { buildPrivateTurnCorrectTools, buildPrivateTurnForgetTools,
  buildPrivateTurnMemoryTools, buildPrivateTurnRecallTools, buildPrivateTurnRememberTools,
  checkPrivateTurnTools } from './turn-tools.ts';

const builders = { recall: buildPrivateTurnRecallTools, remember: buildPrivateTurnRememberTools,
  correct: buildPrivateTurnCorrectTools, forget: buildPrivateTurnForgetTools,
  all: buildPrivateTurnMemoryTools };
type Input = Omit<Parameters<typeof buildPrivateTurnRecallTools>[0], 'canUse'> & {
  store: EventStore;
  binding: Binding;
  operation: keyof typeof builders;
};

export async function preparePersonalMemoryTools(input: Input) {
  const original = { ...input };
  const deadline = performance.now() + 10_000;
  try {
    // Read saved membership before the catalogue or permissions can fail.
    const membership = await savedMember(original, deadline);
    if (original.binding.silo !== original.silo) return [];
    let access: Awaited<ReturnType<typeof preparationAccess>>;
    async function readServer(serverId: string) {
      // Let the builder check its private caller and qualification before asking IAM.
      access = await preparationAccess(original, membership, deadline);
      if (!access) return undefined;
      return original.readServer(serverId);
    }
    function canUse(serverId: string, kind: 'person' | 'assistant', subject: string) {
      if (!access) return Promise.resolve(false);
      return access.canUse(serverId, kind, subject);
    }
    const prepared = { ...original, readServer, canUse };
    const tools = await builders[original.operation](prepared);
    await confirmPositions(original, membership.positions, deadline);
    // Reject replacements of the trusted inputs as well as changes inside their objects.
    function unchanged([key, value]: [string, unknown]) {
      return Reflect.get(input, key) === value;
    }
    const fields = Object.entries(original);
    if (!fields.every(unchanged)) return [];
    if (!prepared.caller || !prepared.grant) return [];
    const identity = { caller: prepared.caller, grant: prepared.grant };
    // Recheck the original approval after our final store reads have finished.
    if (!checkPrivateTurnTools(tools, identity)) return [];
    return tools;
  } catch (error) {
    // Keep an established refusal even if a later membership read would fail.
    if (error instanceof MemberAccessRefused) throw error;
    try {
      // Detect removal during a failed dependency read without asking IAM again.
      await savedMember(original, deadline);
    } catch (membershipError) {
      if (membershipError instanceof MemberAccessRefused) throw membershipError;
    }
    return [];
  }
}

async function savedMember(input: Input, deadline: number) {
  const membership = await currentMembership(input.store, input.silo, input.requesterId,
    undefined, deadline);
  if (!membership.role) throw new MemberAccessRefused('Active silo membership required');
  return membership;
}

type Membership = Awaited<ReturnType<typeof currentMembership>>;

async function preparationAccess(input: Input, membership: Membership, deadline: number) {
  const auth = memberAuthorisation(input.binding);
  const permission = await auth.check(input.requesterId, 'member');
  if (permission.status === 'unavailable') throw new Error('Permissions unavailable');
  if (!permission.allowed) throw new MemberAccessRefused('Membership unavailable');
  const facts = await accessFacts(input, membership, deadline);
  for (const row of facts) {
    if (!await auth.applied(row.event.id)) throw new Error('Permissions still being applied');
    requireTime(deadline);
  }
  const requester = await auth.use('person', input.requesterId, 'mcp_server', 'memory');
  if (requester.status !== 'ok' || !requester.allowed) return undefined;
  const assistant = await auth.use('assistant', input.assistantId, 'mcp_server', 'memory');
  if (assistant.status !== 'ok' || !assistant.allowed) return undefined;
  await confirmPositions(input, membership.positions, deadline);
  function canUse(serverId: string, kind: 'person' | 'assistant', subject: string) {
    if (serverId !== 'memory') return Promise.resolve(false);
    if (kind === 'person') return Promise.resolve(subject === input.requesterId);
    return Promise.resolve(subject === input.assistantId);
  }
  return { canUse };
}

async function accessFacts(input: Input, membership: Membership, deadline: number) {
  const facts = [...membership.facts];
  async function capture(subject: string) {
    const rows = await history(input.store, subject, input.silo, deadline);
    membership.positions.set(subject, rows.at(-1)?.sequence ?? 0);
    facts.push(...rows);
    return rows;
  }
  const grants = await capture(grantStream('mcp_server', 'memory'));
  const teams = new Set<string>();
  for (const row of grants) {
    let grant;
    if (row.event.type === 'grant.given') {
      grant = grantGivenDataSchema.parse(row.event.data);
    } else {
      grant = grantRevokedDataSchema.parse(row.event.data);
    }
    if (grant.granteeKind === 'team') teams.add(`team-${grant.granteeId}`);
  }
  // Include past team grants while IAM might still be applying their removal.
  for (const subject of teams) await capture(subject);
  return facts;
}

function requireTime(deadline: number) {
  if (performance.now() >= deadline) throw new Error('Memory tool preparation expired');
}

async function confirmPositions(input: Input, positions: ReadonlyMap<string, number>,
  deadline: number) {
  requireTime(deadline);
  // Check membership first so another unavailable stream cannot hide saved removal.
  const membership = await savedMember(input, deadline);
  for (const [subject, position] of membership.positions) {
    if (positions.get(subject) !== position) throw new Error('Access changed');
  }
  for (const [subject, position] of positions) {
    if (await input.store.head(subject, deadline) !== position) throw new Error('Access changed');
  }
  requireTime(deadline);
}

const stopIdentity = z.object({ turnId: z.string() });
const receiptId = z.string().regex(/^[\w-]{1,200}$/u);
const recallReceipt = z.strictObject({
  type: z.enum(['recall_pending', 'recall_loaded']), loadId: z.uuid(),
  silo: receiptId, requesterId: receiptId, assistantId: receiptId, computerId: receiptId,
  conversationId: receiptId, turnId: receiptId, threadId: receiptId,
  generation: z.int().positive(), inputGeneration: z.int().positive(), expiresAt: z.int().positive(),
});

type RecallLoadInput = Pick<Input, 'store' | 'binding' | 'silo' | 'requesterId' |
  'assistantId' | 'baseMessageBytes' | 'caller' | 'callers' | 'grant'>;

async function readRecallServer(input: RecallLoadInput, deadline: number) {
  const policy = await readToolPolicy(input.store, input.silo, 'memory', deadline);
  if (!policy.catalogue) return undefined;
  const available = policy.catalogue.tools ?? [];
  function definition(tool: typeof available[number]) {
    return { name: tool.name, revision: tool.revision,
      ...(tool.definition === undefined ? {} : { definition: tool.definition }) };
  }
  function choice(tool: typeof policy.tools[number]) {
    return { name: tool.name, revision: tool.revision, reviewed: tool.reviewed, mode: tool.mode,
      ...(tool.costCents === undefined ? {} : { costCents: tool.costCents }) };
  }
  const discoveryTools = available.map(definition);
  const policyTools = policy.tools.map(choice);
  return { serverId: 'memory', connectionId: policy.connectionId, published: policy.published,
    accountMode: policy.accountMode, discoveryTools, policyTools,
    ...(policy.catalogue.serverInfo ? { serverInfo: policy.catalogue.serverInfo } : {}) };
}

// Keep this preparation local. Only request contains fields for the computer bridge.
export async function preparePersonalRecallLoad(input: RecallLoadInput, pending: unknown) {
  const deadline = performance.now() + 10_000;
  const local = { ...input };
  const readServer = readRecallServer.bind(undefined, local, deadline);
  const original: Input = { ...local, operation: 'recall', turn: undefined, readServer,
    scopeId: memoryScopeId(input.silo, 'person', input.requesterId) };
  try {
    const membership = await savedMember(original, deadline);
    const receipt = recallReceipt.parse(pending);
    const expected = expectedRecallReceipt(original, receipt.loadId);
    requireSameReceipt(receipt, expected, 'recall_pending');
    await accessFacts(original, membership, deadline);
    for (const subject of [`assistant-${original.assistantId}`, 'mcp-memory']) {
      const rows = await history(original.store, subject, original.silo, deadline);
      membership.positions.set(subject, rows.at(-1)?.sequence ?? 0);
    }
    const measured = await readDeploymentQualification(original.silo);
    const prepared = await savedRecallTools(original, measured, membership.positions, deadline);
    await confirmPositions(original, membership.positions, deadline);
    await prepared.confirm();
    measured.confirm();
    const encoded = JSON.stringify(prepared.tools);
    const request = { ...receipt, type: 'recall_load' as const, tools: structuredClone(prepared.tools) };
    if (Buffer.byteLength(JSON.stringify(request)) > 120 * 1024) throw new LoadedMemoryRefused();
    let used = false;
    async function complete(reply: unknown) {
      try {
        if (used) throw new LoadedMemoryRefused();
        used = true;
        // Consume even a bad receipt. A lost or refused load must never be resent.
        await confirmPositions(original, membership.positions, deadline);
        requireSameReceipt(recallReceipt.parse(reply), expected, 'recall_loaded');
        const currentIdentity = expectedRecallReceipt(original, expected.loadId);
        requireSameReceipt(currentIdentity, expected, 'recall_pending');
        const current = await readDeploymentQualification(original.silo);
        if (current.runId !== measured.runId) throw new LoadedMemoryRefused();
        const prepared = await savedRecallTools(original, current, membership.positions, deadline);
        const tools = prepared.tools;
        if (JSON.stringify(tools) !== encoded) throw new LoadedMemoryRefused();
        await confirmPositions(original, membership.positions, deadline);
        await prepared.confirm();
        measured.confirm();
        current.confirm();
        const identity = { caller: original.caller!, grant: original.grant! };
        if (!checkPrivateTurnTools(tools, identity)) throw new LoadedMemoryRefused();
        return tools;
      } catch (error) {
        return refuseRecallLoad(original, deadline, error);
      }
    }
    return { request, complete };
  } catch (error) {
    return refuseRecallLoad(original, deadline, error);
  }
}

function expectedRecallReceipt(input: Input, loadId: string) {
  const grant = input.grant;
  if (!grant || input.operation !== 'recall') throw new LoadedMemoryRefused();
  return { type: 'recall_pending' as const, loadId, silo: input.silo,
    requesterId: input.requesterId, assistantId: input.assistantId,
    computerId: grant.computerId, conversationId: grant.conversation,
    turnId: grant.turnId, threadId: grant.thread, generation: grant.generation,
    inputGeneration: grant.inputGeneration, expiresAt: grant.expires };
}

function requireSameReceipt(actual: z.infer<typeof recallReceipt>,
  expected: z.infer<typeof recallReceipt>, type: 'recall_pending' | 'recall_loaded') {
  if (actual.type !== type || expected.expiresAt <= Date.now()) throw new LoadedMemoryRefused();
  for (const [name, value] of Object.entries(expected)) {
    if (name !== 'type' && Reflect.get(actual, name) !== value) throw new LoadedMemoryRefused();
  }
}

async function savedRecallTools(input: Input,
  measured: Awaited<ReturnType<typeof readDeploymentQualification>>,
  positions: ReadonlyMap<string, number>, deadline: number) {
  const grant = input.grant;
  if (!grant) throw new LoadedMemoryRefused();
  const activity = await approvalActivity(input.store, input.silo, input.assistantId,
    grant.conversation, grant.turnId, deadline);
  const chat = await readChatFacts(input.store, input.silo, grant.conversation, grant.turnId);
  if (chat.memoryContext?.status === 'invalidated' || chat.memoryContext?.status === 'ended') {
    throw new LoadedMemoryRefused();
  }
  const computer = activity.computer;
  const lifecycle = z.object({ computerId: z.literal(grant.computerId),
    generation: z.literal(grant.generation) });
  if (computer.lifecycle?.event.type !== 'computer.ready' || computer.control
    || !lifecycle.safeParse(computer.lifecycle.event.data).success
    || chat.conversationClosed || chat.turnEnded) throw new LoadedMemoryRefused();
  for (const row of activity.conversation) {
    if (row.event.type === 'agent.turn_stop_requested'
      && stopIdentity.parse(row.event.data).turnId === grant.turnId) {
      throw new LoadedMemoryRefused();
    }
  }
  const assistants = await history(input.store, `assistant-${input.assistantId}`,
    input.silo, deadline);
  function isCreation(row: typeof assistants[number]) {
    return row.event.type === 'assistant.created';
  }
  const owner = z.object({ kind: z.literal('personal'), ownerId: z.literal(input.requesterId) });
  const created = assistants.find(isCreation);
  owner.parse(created?.event.data);
  if (!computer.firstStart) throw new LoadedMemoryRefused();
  const turn = { ...computer, firstStart: computer.firstStart, hasStart: true };
  const prepared = { ...input, turn, ...measured.catalogue };
  const tools = await preparePersonalMemoryTools(prepared);
  if (tools.length !== 1) throw new LoadedMemoryRefused();
  // Read history first, then check only small access streams within two seconds.
  const subjects = [...positions.keys()];
  const authority = await decisionAuthorityFence(input.store, performance.now(), subjects,
    input.requesterId, input.assistantId, undefined, deadline);
  async function confirm() {
    await confirmDecisionAccess(activity, authority, false);
    measured.confirm();
  }
  await confirm();
  return { tools, confirm };
}

async function refuseRecallLoad(input: Input, deadline: number, error: unknown): Promise<never> {
  if (error instanceof MemberAccessRefused) throw error;
  try {
    await savedMember(input, deadline);
  } catch (membershipError) {
    if (membershipError instanceof MemberAccessRefused) throw membershipError;
  }
  throw new LoadedMemoryRefused();
}
