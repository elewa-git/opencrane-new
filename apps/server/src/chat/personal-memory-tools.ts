import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { grantGivenDataSchema, grantRevokedDataSchema } from '@opencrane/events';
import { currentMembership, history, MemberAccessRefused } from '@opencrane/models';
import { buildPrivateTurnCorrectTools, buildPrivateTurnForgetTools,
  buildPrivateTurnRecallTools, buildPrivateTurnRememberTools } from './turn-tools.ts';

const builders = { recall: buildPrivateTurnRecallTools, remember: buildPrivateTurnRememberTools,
  correct: buildPrivateTurnCorrectTools, forget: buildPrivateTurnForgetTools };
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
