import type { EventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { supersededEvent, removedParticipant, ownerAtTransfer,
  memberEventBeforeOwnershipSeed, requireEarlierRoleChanges } from './backfill.ts';
import { legacyMemberRole, ownershipSeededSchema, ownershipTransferredSchema,
  ownershipSteppedDownSchema, conversationCreatedDataSchema, conversationEventId,
  grantRevokedDataSchema, handlerSubscriptions, parseEventByType, type EventEnvelope } from "@opencrane/events";
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

/** Keep all grants for a resource on one worker key so they stay in order. */
export function grantStream(resourceType: string, resourceId: string): string {
  return `grant-${Buffer.from(JSON.stringify([resourceType, resourceId])).toString('base64url')}`;
}

// Cache only startup or setup bindings so request data cannot grow this map.
const authorisations = new Map<string, ReturnType<typeof createMemberAuthorisation>>();

export function memberAuthorisation(binding: Binding,
  store?: Pick<EventStore, 'readStream'>) {
  // Keep the client tied to these values if a caller later changes the binding.
  const cachedBinding = Object.freeze({
    apiUrl: binding.apiUrl,
    storeId: binding.storeId,
    authorizationModelId: binding.authorizationModelId,
    silo: binding.silo,
  } satisfies Binding);
  if (store) {
    return createMemberAuthorisation(cachedBinding, store);
  }
  const key = JSON.stringify(cachedBinding);
  const existing = authorisations.get(key);
  if (existing) return existing;

  const authorisation = createMemberAuthorisation(cachedBinding);
  authorisations.set(key, authorisation);
  return authorisation;
}

function createMemberAuthorisation(binding: Binding,
  store?: Pick<EventStore, 'readStream'>) {
  const logger = createLogger('update-openfga');
  async function applied(eventId: string) {
    const receipt = { user: object, relation: 'applied',
      object: objectId('projection_event', binding.silo, eventId) };
    return (await client.read(receipt)).length > 0;
  }
  const client = new TupleClient(binding);
  const object = objectId("silo", binding.silo);

  async function applyConversation(event: EventEnvelope, receipt: Tuple) {
    const conversationId = conversationEventId(event);
    const target = objectId('conversation', binding.silo, conversationId);
    let participantIds: string[];
    let creatorId: string | undefined;
    if (event.type === 'conversation.created') {
      const created = conversationCreatedDataSchema.parse(event.data);
      participantIds = [created.createdBy];
      if (created.mode !== 'agent_session') participantIds = created.participantIds;
      if (created.mode === 'group') creatorId = created.createdBy;
    } else {
      participantIds = [field(event.data, 'participantId')];
    }
    const writes: Tuple[] = [receipt];
    const deletes: Tuple[] = [];
    if (event.type === 'conversation.created') {
      writes.push({ user: object, relation: 'silo', object: target });
    }
    if (creatorId) {
      const creator = { user: objectId('person', binding.silo, creatorId),
        relation: 'creator', object: target };
      writes.push(creator);
    }
    for (const participantId of participantIds) {
      if (store && await removedParticipant(store, event, participantId, applied)) {
        continue;
      }
      const participant = {
        user: objectId('person', binding.silo, participantId),
        relation: 'participant', object: target,
      };
      const exists = (await client.read(participant)).length > 0;
      if (!exists && event.type !== 'participant.removed') writes.push(participant);
      if (exists && event.type === 'participant.removed') deletes.push(participant);
    }
    await client.write(writes, deletes);
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

  function granteeUser(kind: string, id: string) {
    let identityKind = kind;
    if (kind === 'member') identityKind = 'person';
    const user = objectId(identityKind, binding.silo, id);
    if (kind === 'team') return `${user}#member`;
    return user;
  }

  async function laterGrantForKind(event: EventEnvelope, kind: string) {
    if (!store || event.type !== 'grant.revoked') {
      return false;
    }
    const revoked = grantRevokedDataSchema.parse(event.data);
    if (revoked.granteeKind !== undefined) {
      return false;
    }
    // Check each identity separately because old removals covered every matching id.
    const data = { ...revoked, granteeKind: kind };
    const specific = { ...event, data };
    return supersededEvent(store, specific, applied);
  }

  async function applyGrant(event: EventEnvelope, receipt: Tuple) {
    const resourceType = field(event.data, 'resourceType'), resourceId = field(event.data, 'resourceId');
    if (event.subject !== grantStream(resourceType, resourceId)) throw new Error('Grant subject mismatch');
    const target = objectId('resource', binding.silo, resourceType, resourceId);
    const grantee = field(event.data, 'granteeId');
    const kind = event.type === 'grant.given' ? field(event.data, 'granteeKind')
      : grantRevokedDataSchema.parse(event.data).granteeKind;
    let identityKinds = ['member', 'assistant', 'team'];
    if (kind) identityKinds = [kind];
    const users = new Set<string>();
    for (const identityKind of identityKinds) {
      if (await laterGrantForKind(event, identityKind)) {
        const fields = { eventId: event.id, granteeKind: identityKind, stream: event.subject };
        logger.info(fields, 'Kept a later grant while applying an old removal');
        continue;
      }
      users.add(granteeUser(identityKind, grantee));
    }
    function matchesGrantee(tuple: Tuple) {
      return users.has(tuple.user);
    }
    // Keep an assistant grant separate from its owner's group grant, even if ids match.
    const current = await client.read({ object: target, relation: 'use' });
    const existing = current.filter(matchesGrantee);
    const desired: Tuple[] = [];
    if (event.type === 'grant.given' && kind) {
      const user = granteeUser(kind, grantee);
      desired.push({ object: target, relation: 'use', user });
    }
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


  async function applyOwnership(event: EventEnvelope, receipt: Tuple) {
    if (event.subject !== `ownership-${binding.silo}`) {
      throw new Error('Ownership subject mismatch');
    }
    if (event.type === 'ownership.seeded') {
      const seed = ownershipSeededSchema.parse(event.data);
      for (const memberId of seed.ownerIds) {
        const user = objectId('person', binding.silo, memberId);
        const tuple = { user, object, relation: 'owner_role' };
        const projectedOwner = await client.read(tuple);
        if (!projectedOwner.length) {
          throw new Error('Seed owner is not projected');
        }
      }
      await client.write([receipt], []);
      return;
    }
    const memberId = field(event.data, 'memberId');
    const user = objectId('person', binding.silo, memberId);
    const current = await client.read({ user, object });
    function hasMembership(tuple: Tuple) {
      return tuple.relation === 'member';
    }
    if (!current.some(hasMembership)) {
      throw new Error('Ownership requires active membership');
    }
    const owner = { user, object, relation: 'owner_role' };
    const admin = { user, object, relation: 'admin_role' };
    if (event.type === 'ownership.transferred') {
      const transfer = ownershipTransferredSchema.parse(event.data);
      const actor = objectId('person', binding.silo, transfer.transferredBy);
      const actorTuple = { user: actor, object, relation: 'owner_role' };
      const actorOwners = await client.read(actorTuple);
      let authorised = actorOwners.length > 0;
      if (store) {
        authorised = await ownerAtTransfer(store, event);
      }
      if (!authorised) {
        throw new Error('Transfer requires an owner');
      }
      const existingOwners = await client.read(owner);
      const exists = existingOwners.length > 0;
      await client.write(exists ? [receipt] : [owner, receipt], []);
      return;
    }
    ownershipSteppedDownSchema.parse(event.data);
    const owners = await client.read({ object, relation: 'owner_role' });
    const currentOwner = await client.read(owner);
    if (owners.length < 2 || !currentOwner.length) {
      throw new Error('At least one owner must remain');
    }
    const existingAdmins = await client.read(admin);
    const hasAdmin = existingAdmins.length > 0;
    await client.write(hasAdmin ? [receipt] : [admin, receipt], [owner]);
  }

  async function refuseMemberOwnerEdit(event: EventEnvelope, current: Tuple[]) {
    const seeded = await client.read({ user: object, relation: 'applied',
      object: objectId('projection_event', binding.silo, `ownership-seed-${binding.silo}`) });
    function isOwner(tuple: Tuple) {
      return tuple.relation === 'owner_role';
    }
    const nextRole = legacyMemberRole(event);
    if (seeded.length && (current.some(isOwner) || nextRole === 'owner')) {
      if (store && await memberEventBeforeOwnershipSeed(store, event)) {
        return false;
      }
      if (current.some(isOwner) && event.type === 'member.role_changed'
        && (nextRole === 'member' || nextRole === 'admin')) {
        return true;
      }
      throw new Error('Owner changes require the ownership stream');
    }
    return false;
  }

  async function applyProvider(event: EventEnvelope, receipt: Tuple) {
    const providerId = field(event.data, 'providerId');
    if (event.subject !== `provider-${providerId}`) throw new Error('Provider subject mismatch');
    const target = objectId('provider', binding.silo, providerId);
    const siloTuple = { user: object, object: target, relation: 'silo' };
    await client.write([siloTuple, receipt], []);
  }

  async function apply(input: EventEnvelope): Promise<void> {
    const parsed = parseEventByType(input);
    if (!parsed.success || parsed.event.silo !== binding.silo) {
      throw new Error("Invalid authorisation event or silo");
    }
    const event = parsed.event;
    const supported: readonly string[] = handlerSubscriptions['update-openfga'];
    if (!supported.includes(event.type)) {
      throw new Error(`OpenFGA event not implemented: ${event.type}`);
    }
    const receipt = {
      user: object,
      relation: "applied",
      object: objectId("projection_event", binding.silo, event.id),
    };
    if ((await client.read(receipt)).length) return;
    if (store && await supersededEvent(store, event, applied)) {
      await client.write([receipt], []);
      const fields = { eventId: event.id, eventType: event.type, stream: event.subject };
      logger.info(fields, 'Skipped an old event because a later permission change was already applied');
      return;
    }
    if (store && (event.type === 'member.role_changed'
      || event.type === 'ownership.transferred')) {
      await requireEarlierRoleChanges(store, event, applied);
    }
    if (event.type.startsWith('ownership.')) {
      return applyOwnership(event, receipt);
    }
    const creationHandlers: Record<string, typeof applyProvider> = {
      'provider.created': applyProvider,
      'assistant.created': applyAssistant,
    };
    const creationHandler = creationHandlers[event.type];
    if (creationHandler) return creationHandler(event, receipt);
    if (event.type.startsWith('team.')) return applyTeam(event, receipt);
    if (event.type.startsWith('grant.')) return applyGrant(event, receipt);
    if (['conversation.created', 'participant.added', 'participant.removed'].includes(event.type)) {
      await applyConversation(event, receipt);
      return;
    }
    await applyMember(event, receipt);
  }

  async function applyMember(event: EventEnvelope, receipt: Tuple): Promise<void> {
    const memberId = field(event.data, "memberId");
    if (event.subject !== `member-${memberId}`) {
      throw new Error("Member subject mismatch");
    }
    const user = objectId("person", binding.silo, memberId);
    const current = await client.read({ user, object });
    const noEffect = await refuseMemberOwnerEdit(event, current);
    if (noEffect) {
      await client.write([receipt], []);
      return;
    }
    function isMember(tuple: Tuple): boolean {
      return tuple.relation === 'member';
    }
    if (event.type === "member.role_changed" && !current.some(isMember)) {
      throw new Error("Role change requires an existing member");
    }
    let desired: Tuple[] = [];
    if (event.type !== 'member.removed') {
      desired = roleTuples(user, object, legacyMemberRole(event) ?? '');
    }
    function missingTuple(tuple: Tuple): boolean {
      function matchesCurrent(existing: Tuple): boolean {
        return same(tuple, existing);
      }
      return !current.some(matchesCurrent);
    }
    function unwantedTuple(tuple: Tuple): boolean {
      function matchesDesired(existing: Tuple): boolean {
        return same(tuple, existing);
      }
      return !desired.some(matchesDesired);
    }
    const missing = desired.filter(missingTuple);
    const unwanted = current.filter(unwantedTuple);
    const writes = [...missing, receipt];
    // The receipt and changes commit together, so a lost reply is safe to retry.
    // An old event after removal cannot restore the removed permissions.
    await client.write(writes, unwanted);
  }

  return {
    binding,
    async applied(eventId: string) {
      return (await client.check({ user: object, relation: 'applied', object: objectId('projection_event', binding.silo, eventId) })).allowed;
    },
    provider(memberId: string, providerId: string, relation: 'read' | 'manage') {
      return client.check({ user: objectId('person', binding.silo, memberId), relation,
        object: objectId('provider', binding.silo, providerId) });
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
    conversation(memberId: string, conversationId: string,
      relation: 'read' | 'post' | 'manage_participants') {
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
