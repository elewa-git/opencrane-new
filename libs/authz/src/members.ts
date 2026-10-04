import { parseEventByType, type EventEnvelope } from "@opencrane/events";
import { registerHandler } from "@opencrane/handlers";
import { objectId, TupleClient, type Binding, type Tuple } from "./client.ts";

function field(data: unknown, name: string): string {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid member data");
  }
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== "string") {
    throw new Error("Missing member field");
  }
  return value;
}

function roleTuples(user: string, object: string, role: string): Tuple[] {
  const tuples = [{ user, object, relation: "member" }];
  if (role === "owner" || role === "admin") {
    tuples.push({ user, object, relation: `${role}_role` });
  }
  return tuples;
}

function same(a: Tuple, b: Tuple): boolean {
  return (
    a.user === b.user && a.object === b.object && a.relation === b.relation
  );
}

/** All grantees of one resource share the worker's ordering key. */
export function grantStream(resourceType: string, resourceId: string): string {
  return `grant-${Buffer.from(JSON.stringify([resourceType, resourceId])).toString('base64url')}`;
}

export function memberAuthorisation(binding: Binding) {
  const client = new TupleClient(binding);
  const object = objectId("silo", binding.silo);

  async function applyConversation(event: EventEnvelope, receipt: Tuple) {
      const conversationId = field(event.data, 'conversationId');
      if (event.subject !== `conversation-${conversationId}`) throw new Error('Conversation subject mismatch');
      const target = objectId('conversation', binding.silo, conversationId);
      const participant = { user: objectId('person', binding.silo,
        field(event.data, event.type === 'conversation.created' ? 'createdBy' : 'participantId')), relation: 'participant', object: target };
      const exists = (await client.read(participant)).length > 0;
      await client.write([receipt,
        ...(event.type === 'conversation.created' ? [{ user: object, relation: 'silo', object: target }] : []),
        ...(!exists && event.type !== 'participant.removed' ? [participant] : [])],
      exists && event.type === 'participant.removed' ? [participant] : []);
  }

  async function applyTeam(event: EventEnvelope, receipt: Tuple) {
    const teamId = field(event.data, 'teamId');
    if (event.subject !== `team-${teamId}`) throw new Error('Team subject mismatch');
    const target = objectId('team', binding.silo, teamId);
    if (event.type === 'team.created') { await client.write([receipt], []); return; }
    const tuple = { user: objectId('person', binding.silo, field(event.data, 'memberId')), relation: 'member', object: target };
    const exists = (await client.read(tuple)).length > 0;
    await client.write([receipt, ...(!exists && event.type === 'team.member_added' ? [tuple] : [])],
      exists && event.type === 'team.member_removed' ? [tuple] : []);
    return;
  }

  async function applyGrant(event: EventEnvelope, receipt: Tuple) {
    const resourceType = field(event.data, 'resourceType'), resourceId = field(event.data, 'resourceId');
    if (event.subject !== grantStream(resourceType, resourceId)) throw new Error('Grant subject mismatch');
    const target = objectId('resource', binding.silo, resourceType, resourceId);
    const grantee = field(event.data, 'granteeId');
    const existing = (await client.read({ object: target, relation: 'use' }))
      .filter(t => ['person', 'assistant', 'team'].some(kind => t.user === objectId(kind, binding.silo, grantee) + (kind === 'team' ? '#member' : '')));
    const kind = event.type === 'grant.given' ? field(event.data, 'granteeKind') : undefined;
    const desired = kind ? [{ object: target, relation: 'use', user: objectId(kind === 'member' ? 'person' : kind, binding.silo, grantee) + (kind === 'team' ? '#member' : '') }] : [];
    await client.write([receipt, ...desired.filter(t => !existing.some(e => same(t, e)))], existing.filter(t => !desired.some(d => same(t, d))));
    return;
  }

  async function applyAssistant(event: EventEnvelope, receipt: Tuple) {
    const assistantId = field(event.data, 'assistantId');
    const ownerId = field(event.data, 'ownerId');
    if (event.subject !== `assistant-${assistantId}`) throw new Error('Assistant subject mismatch');
    await client.write([{ user: field(event.data, 'kind') === 'team' ? `${objectId('team', binding.silo, ownerId)}#member` : objectId('person', binding.silo, ownerId), relation: 'acts_for',
      object: objectId('assistant', binding.silo, assistantId) }, receipt], []);
  }

  async function apply(input: EventEnvelope): Promise<void> {
    const parsed = parseEventByType(input);
    if (!parsed.success || parsed.event.silo !== binding.silo) {
      throw new Error("Invalid authorisation event or silo");
    }
    const event = parsed.event;
    if (!["member.joined", "member.role_changed", "member.removed", "assistant.created", "conversation.created", "participant.added", "participant.removed", "grant.given", "grant.revoked", "team.created", "team.member_added", "team.member_removed"].includes(event.type)) {
      throw new Error(`OpenFGA event not implemented: ${event.type}`);
    }
    const receipt = {
      user: object,
      relation: "applied",
      object: objectId("projection_event", binding.silo, event.id),
    };
    if ((await client.read(receipt)).length) return;
    if (event.type.startsWith('team.')) return applyTeam(event, receipt);
    if (event.type.startsWith('grant.')) return applyGrant(event, receipt);
    if (['conversation.created', 'participant.added', 'participant.removed'].includes(event.type)) {
      await applyConversation(event, receipt);
      return;
    }
    if (event.type === 'assistant.created') {
      return applyAssistant(event, receipt);
    }
    const memberId = field(event.data, "memberId");
    if (event.subject !== `member-${memberId}`) {
      throw new Error("Member subject mismatch");
    }
    const user = objectId("person", binding.silo, memberId);
    const current = await client.read({ user, object });
    if (
      event.type === "member.role_changed" &&
      !current.some((t) => t.relation === "member")
    ) {
      throw new Error("Role change requires an existing member");
    }
    const desired =
      event.type === "member.removed"
        ? []
        : roleTuples(
            user,
            object,
            field(
              event.data,
              event.type === "member.joined" ? "role" : "newRole",
            ),
          );
    // A lost reply is safe: the receipt and changes either all commit or all fail.
    // Repeating an old event after removal cannot restore its previous permissions.
    await client.write(
      [...desired.filter((t) => !current.some((c) => same(t, c))), receipt],
      current.filter((t) => !desired.some((d) => same(t, d))),
    );
  }

  return {
    binding,
    async applied(eventId: string) {
      return (await client.check({ user: object, relation: 'applied', object: objectId('projection_event', binding.silo, eventId) })).allowed;
    },
    use(kind: 'person' | 'assistant', id: string, resourceType: string, resourceId: string) {
      return client.check({ user: objectId(kind, binding.silo, id), relation: 'use', object: objectId('resource', binding.silo, resourceType, resourceId) });
    },
    handler: registerHandler("update-openfga", apply),
    check(memberId: string, relation: "member" | "admin" | "owner") {
      return client.check({
        user: objectId("person", binding.silo, memberId),
        object,
        relation,
      });
    },
    conversation(memberId: string, conversationId: string, relation: 'read' | 'post') {
      return client.check({ user: objectId('person', binding.silo, memberId),
        object: objectId('conversation', binding.silo, conversationId), relation });
    },
    team(memberId: string, teamId: string) {
      return client.check({ user: objectId('person', binding.silo, memberId), object: objectId('team', binding.silo, teamId), relation: 'member' });
    },
    desktop(memberId: string, computerId: string) {
      return client.check({ user: objectId('person', binding.silo, memberId),
        object: objectId('resource', binding.silo, 'shared_desktop', computerId), relation: 'use' });
    },
    view(memberId: string, conversationId: string, computerId: string, receipts: string[]) {
      const user = objectId('person', binding.silo, memberId);
      function receiptTuple(eventId: string) {
        return { user: object, relation: 'applied',
          object: objectId('projection_event', binding.silo, eventId) };
      }
      const receiptTuples = receipts.map(receiptTuple);
      const checks = [
        { user, object: objectId('conversation', binding.silo, conversationId), relation: 'read' },
        { user, object: objectId('resource', binding.silo, 'shared_desktop', computerId), relation: 'use' },
        ...receiptTuples,
      ];
      return client.checkAll(checks);
    },
    actsFor(memberId: string, assistantId: string) {
      return client.check({ user: objectId('person', binding.silo, memberId),
        object: objectId('assistant', binding.silo, assistantId), relation: 'acts_for' });
    },
  };
}
