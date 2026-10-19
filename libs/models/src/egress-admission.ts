import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JSONWebKeySet } from 'jose';
import { tokenVerifier, verifyEgressCapability, type EgressCapability } from '@opencrane/auth';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { egressDestinationDataSchema, egressObservationId, legacyMemberRole }
  from '@opencrane/events';
import { egressGrantStream } from '@opencrane/projections';
import { egressHistory } from './egress-history.ts';
import { requireBudget } from './budget-refusal.ts';
import { BudgetActor, envelope } from './actor.ts';
import { authorityFence, isAuthorityChanged } from './authority.ts';
import { approvalActivity, requireActiveConversationTurn } from './decision-activity.ts';
import { data, priceTableId } from './state.ts';
import { turnRootBinding } from './root-budget.ts';
import type { EgressRelayRegistry } from './egress-relay.ts';

class MissingRule extends Error {}
type Activity = Awaited<ReturnType<typeof approvalActivity>>;
type Read = ReturnType<typeof egressHistory>['read'];
type Fresh = Awaited<ReturnType<typeof authorityFence>>;

function activeWork(claims: EgressCapability, activity: Activity) {
  const computer = activity.computer.lifecycle;
  const turn = activity.computer.firstStart;
  if (!computer || computer.event.type !== 'computer.ready' || !turn ||
      turn.event.source !== 'opencrane-server' || activity.computer.firstClose ||
      activity.computer.control || turn.sequence <= computer.sequence) throw new Error('Egress refused');
  const ready = data(computer.event);
  const started = data(turn.event);
  requireWorkBinding(ready, started, claims);
  requireActiveConversationTurn(activity.conversation, claims.turn);
  for (const row of activity.conversation) {
    if (row.event.type === 'conversation.closed') {
      throw new Error('Egress refused');
    }
    if (row.event.type === 'conversation.created' &&
        data(row.event)['assistantId'] !== claims.assistant) throw new Error('Egress refused');
  }
  const payingGroupId = started['payingGroupId'];
  if (typeof payingGroupId !== 'string') throw new Error('Egress refused');
  return { payingGroupId, admittedAt: turn.sequence };
}

function requireWorkBinding(ready: Record<string, unknown>, started: Record<string, unknown>,
  claims: EgressCapability) {
  if (ready['assistantId'] !== claims.assistant || started['assistantId'] !== claims.assistant ||
      ready['computerId'] !== claims.computer || ready['generation'] !== claims.generation ||
      started['computerId'] !== claims.computer || started['requesterId'] !== claims.requester ||
      started['conversationId'] !== claims.conversation || started['threadId'] !== claims.thread ||
      started['task'] !== 'chat_turn' || started['sharingClass'] !== undefined) {
    throw new Error('Egress refused');
  }
}

async function checkTeam(actor: BudgetActor, binding: Binding, fields: Record<string, unknown>,
  fresh: Fresh, read: Read) {
  if (fields['kind'] !== 'team') return;
  const subject = `team-${String(fields['ownerId'])}`;
  fresh.include(subject);
  const team = await read(subject, fresh.deadline);
  const auth = memberAuthorisation(binding);
  for (const change of team) {
    if (!await auth.applied(change.event.id)) throw new Error('Egress refused');
  }
}

async function checkMember(actor: BudgetActor, binding: Binding, claims: EgressCapability,
  fresh: Fresh, read: Read) {
  const auth = memberAuthorisation(binding);
  const members = await read(`member-${claims.requester}`, fresh.deadline);
  let member = false;
  for (const row of members) {
    const role = legacyMemberRole(row.event);
    if (role !== undefined) {
      member = role !== '';
      if (!await auth.applied(row.event.id)) throw new Error('Egress refused');
    }
  }
  if (!member) throw new Error('Egress refused');
}

async function checkAccess(actor: BudgetActor, binding: Binding, claims: EgressCapability,
  activity: Activity, fresh: Fresh, read: Read) {
  const auth = memberAuthorisation(binding);
  await checkMember(actor, binding, claims, fresh, read);
  const assistants = await read(`assistant-${claims.assistant}`, fresh.deadline);
  let active = false;
  for (const row of assistants) {
    const fields = data(row.event);
    if (row.event.type === 'assistant.created') {
      active = true;
      if (!await auth.applied(row.event.id)) throw new Error('Egress refused');
      await checkTeam(actor, binding, fields, fresh, read);
    }
    if (row.event.type === 'assistant.settings_changed' && typeof fields['active'] === 'boolean') {
      active = fields['active'];
    }
  }
  if (!active) throw new Error('Egress refused');
  for (const row of activity.conversation) {
    if (['conversation.created', 'participant.added', 'participant.removed'].includes(row.event.type)) {
      if (!await auth.applied(row.event.id)) throw new Error('Egress refused');
    }
  }
  const permissions = await Promise.all([auth.check(claims.requester, 'member'),
    auth.actsFor(claims.requester, claims.assistant),
    auth.conversation(claims.requester, claims.conversation, 'post')]);
  for (const permission of permissions) {
    if (!permission.allowed) throw new Error('Egress refused');
  }
}

async function checkRules(actor: BudgetActor, claims: EgressCapability, fresh: Fresh, read: Read) {
  const required = [
    ['silo', claims.silo, claims.siloPosition],
    ['person', claims.requester, claims.personPosition],
    ['assistant', claims.assistant, claims.assistantPosition],
  ] as const;
  for (const [scope, subjectId, position] of required) {
    const rule = { host: claims.host, port: claims.port, scope, subjectId };
    const subject = egressGrantStream(actor.silo, rule);
    fresh.include(subject);
    const rows = await read(subject, fresh.deadline);
    const last = rows.at(-1);
    if (!last || last.event.type !== 'egress.destination_allowed') {
      throw new MissingRule(`missing_${scope}_rule`);
    }
    const saved = egressDestinationDataSchema.parse(last.event.data);
    if (saved.scope !== scope || saved.subjectId !== subjectId || saved.host !== claims.host ||
        saved.port !== claims.port || last.sequence !== position) {
      throw new MissingRule(`missing_${scope}_rule`);
    }
  }
}

async function recordRefusedDispatch(actor: BudgetActor, claims: EgressCapability) {
  const digest = createHash('sha256');
  digest.update(JSON.stringify([claims.host, claims.port]));
  const destinationDigest = digest.digest('hex');
  const details = { requestId: claims.jti, permitId: claims.jti, channel: claims.channel,
    destinationDigest, outcome: 'error' };
  const observationId = egressObservationId(actor.silo, claims.jti);
  // Save the existing error outcome without relay fields: no listener was registered.
  const event = envelope(actor.silo, `egress-${claims.jti}`, 'egress.observed',
    details, observationId);
  const command = { event, expectedSequence: 0, deadline: performance.now() + 1000 };
  const result = await actor.store.append(command);
  if (result.status !== 'appended') throw new Error('Egress refused');
}

export async function authoriseEgress(req: IncomingMessage, res: ServerResponse,
  actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding,
  registry?: EgressRelayRegistry) {
  let requestId: string = randomUUID();
  let contextDigest = '0'.repeat(64);
  let claims: EgressCapability | undefined;
  let auditAttempted = false;
  async function audit(outcome: 'allow' | 'deny', reason: string, fresh?: () => Promise<void>) {
    auditAttempted = true;
    const correlation = claims ? { requesterId: claims.requester, assistantId: claims.assistant,
      conversationId: claims.conversation, turnId: claims.turn } : {};
    const details = { requestId, route: 'egress', outcome, reason, contextDigest, ...correlation,
      ...(outcome === 'allow' ? { permitId: requestId } : {}) };
    const event = envelope(actor.silo, `decision-${requestId}`, 'decision.recorded', details);
    const command = { event, expectedSequence: 0, historyChecked: true as const,
      deadline: performance.now() + 2000, ...(fresh ? { checkAccess: fresh } : {}) };
    const saved = await actor.store.append(command);
    if (saved.status !== 'appended') throw new Error('Egress refused');
    return event.id;
  }
  try {
    if (!registry || req.method !== 'POST') throw new Error('Egress refused');
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith('Bearer ')) throw new Error('Egress refused');
    const verifier = tokenVerifier(identity.jwks, identity.issuer);
    // Keep desktop passes closed until their saved lease and control checks are wired.
    const checked = await verifyEgressCapability(verifier, bearer.slice(7), 'command');
    if (checked.silo !== actor.silo || binding.silo !== actor.silo ||
        req.headers['x-egress-authority'] !== `${checked.host}:${checked.port}`) {
      throw new Error('Egress refused');
    }
    claims = checked;
    requestId = checked.jti;
    const digest = createHash('sha256');
    digest.update(JSON.stringify(checked));
    contextDigest = digest.digest('hex');
    const activity = await approvalActivity(actor.store, actor.silo, checked.assistant,
      checked.conversation, checked.turn, performance.now() + 10_000);
    const work = activeWork(checked, activity);
    const subjects = [`member-${checked.requester}`, `assistant-${checked.assistant}`];
    const fresh = await authorityFence(actor.store, performance.now(), subjects);
    const access = egressHistory(actor.store, actor.silo);
    await checkAccess(actor, binding, checked, activity, fresh, access.read);
    await checkRules(actor, checked, fresh, access.read);
    const expiresAt = Math.min(checked.exp * 1000, checked.turnExpiresAt,
      checked.grantExpiresAt, checked.leaseExpiresAt ?? Infinity);
    async function confirm() {
      await activity.confirm(fresh.deadline, false);
      await fresh();
      if (Date.now() >= expiresAt || req.socket.destroyed || res.destroyed) {
        throw new Error('Egress refused');
      }
    }
    await confirm();
    const decisionId = await audit('allow', 'egress_allowed', confirm);
    const modelCall = { model: 'computer-egress', priceTableId, requestId,
      computerId: checked.computer, generation: checked.generation,
      assistantId: checked.assistant, requesterId: checked.requester,
      conversationId: checked.conversation, turnId: checked.turn, threadId: checked.thread,
      payingGroupId: work.payingGroupId, contextDigest };
    const root = turnRootBinding(actor.state, checked.conversation, checked.turn);
    const dispatch = { callId: requestId, decisionId, bodyDigest: checked.operationDigest,
      modelCall, ...root };
    await actor.admitDispatch(dispatch, confirm, work.admittedAt);
    // Recheck after append retries, within the original deadline. This is the last
    // authority check before registration; the relay's 60-second cap applies afterwards.
    async function confirmRegistration() {
      try {
        await confirm();
      } catch (error) {
        await recordRefusedDispatch(actor, checked);
        throw error;
      }
    }
    await confirmRegistration();
    async function recheck() {
      const subjects = [...access.positions.keys()];
      const started = performance.now();
      for (;;) {
        const current = await authorityFence(actor.store, started, subjects);
        await activity.confirm(current.deadline, false);
        await checkAccess(actor, binding, checked, activity, current, access.read);
        await checkRules(actor, checked, current, access.read);
        requireBudget(actor.state, modelCall, actor.now(), work.admittedAt);
        try {
          await current();
          return;
        } catch (error) {
          // Recheck a concurrent change without extending the original deadline.
          if (!isAuthorityChanged(error)) throw error;
        }
      }
    }
    const registration = { recheck, confirm: confirmRegistration, permitId: requestId, host: checked.host, port: checked.port,
      expiresAt: checked.exp * 1000 };
    const relay = await registry.register(registration);
    res.setHeader('x-egress-relay', relay);
    res.end();
  } catch (error) {
    const reason = error instanceof MissingRule ? error.message : 'egress_refused';
    try {
      if (!auditAttempted) await audit('deny', reason);
    } catch {
      res.writeHead(503);
      res.end('{"reason":"egress_unavailable"}');
      return;
    }
    res.writeHead(403);
    const refusal = { reason };
    res.end(JSON.stringify(refusal));
  }
}
