import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { agentToolCallFinishedDataSchema, companyCredentialReleaseSchema,
  decisionRecordedDataSchema, parseEventByType, toolDispatchRecordedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';

const reference = z.strictObject({ eventId: z.string().min(1), position: z.int().positive() });
export const successEvidenceSchema = z.strictObject({
  requestId: z.uuid(), resultReference: reference, reservationId: z.string().min(1),
});
type Evidence = z.infer<typeof successEvidenceSchema>;
type Root = { rootId: string; requesterId: string; assistantId: string;
  computerId: string; generation: number; conversationId: string; turnId: string;
  threadId: string; payingGroupId: string };
type Definition = { connectionId: string; profileId: string; profileRevision: number;
  connectionRevision: number; companyAccountId: string; ownerId: string };
type Decision = z.infer<typeof decisionRecordedDataSchema>;
type Release = z.infer<typeof companyCredentialReleaseSchema>;

async function read(store: EventStore, subject: string, silo: string, deadline: number) {
  const rows = await history(store, subject, silo, deadline);
  if (performance.now() >= deadline) throw new Error('History expired');
  return rows;
}
function matchingRow(rows: StoredEvent[], type: string, referenceValue: {
  eventId: string; position: number }) {
  function hasReference(candidate: StoredEvent) {
    return candidate.event.id === referenceValue.eventId;
  }
  const row = rows.find(hasReference);
  if (!row || row.sequence !== referenceValue.position || row.event.type !== type) {
    throw new Error('Missing saved evidence');
  }
  const parsed = parseEventByType(row.event);
  if (!parsed.success) throw new Error('Invalid saved evidence');
  return row;
}
function requireSource(row: StoredEvent, source: string, principalKind: string,
  principalId: string) {
  if (row.event.source !== source || row.event.principal?.kind !== principalKind ||
      row.event.principal.id !== principalId) {
    throw new Error('Evidence came from another actor');
  }
}
function requireDecisionIdentity(decision: Decision, release: Release, evidence: Evidence,
  root: Root) {
  if (decision.outcome !== 'allow' || decision.route !== 'mcp' ||
      decision.reason !== 'approval_used' || decision.requestId !== evidence.requestId ||
      decision.requesterId !== root.requesterId ||
      decision.assistantId !== root.assistantId ||
      decision.conversationId !== root.conversationId || decision.turnId !== root.turnId ||
      decision.permitId !== release.permitId || release.requestId !== evidence.requestId) {
    throw new Error('Company decision changed');
  }
}
function requireReleaseRun(release: Release, root: Root,
  routineId: string, occurrenceId: string) {
  if (release.userId !== root.requesterId || release.assistantId !== root.assistantId ||
      release.computerId !== root.computerId ||
      release.computerGeneration !== root.generation ||
      release.conversationId !== root.conversationId || release.turnId !== root.turnId ||
      release.threadId !== root.threadId || release.rootId !== root.rootId ||
      release.routineId !== routineId || release.occurrenceId !== occurrenceId ||
      release.payingGroupId !== root.payingGroupId) {
    throw new Error('Company run changed');
  }
}
function requireReleaseAccount(release: Release, definition: Definition, decision: Decision) {
  if (release.ownerId !== definition.ownerId ||
      release.connectionId !== definition.connectionId ||
      release.profileId !== definition.profileId ||
      release.profileRevision !== definition.profileRevision ||
      release.connectionRevision !== definition.connectionRevision ||
      release.companyAccountId !== definition.companyAccountId ||
      decision.serverId !== release.serverId || decision.toolName !== release.toolName) {
    throw new Error('Company account changed');
  }
}
function requireCompanyDecision(rows: StoredEvent[], evidence: Evidence, root: Root,
  definition: Definition, routineId: string, occurrenceId: string) {
  function isDecision(row: StoredEvent) { return row.event.type === 'decision.recorded'; }
  const decisions = rows.filter(isDecision);
  if (decisions.length !== 1) throw new Error('Company decision is not unique');
  requireSource(decisions[0]!, 'models', 'system', 'models');
  const decision = decisionRecordedDataSchema.parse(decisions[0]!.event.data);
  const release = companyCredentialReleaseSchema.parse(decision.release);
  if (decisions[0]!.event.correlation.approval !== release.approvalId) {
    throw new Error('Company approval changed');
  }
  requireDecisionIdentity(decision, release, evidence, root);
  requireReleaseRun(release, root, routineId, occurrenceId);
  requireReleaseAccount(release, definition, decision);
  return { decision, release };
}
function requireUpstreamResult(rows: StoredEvent[], decision: {
  callId?: string | undefined; serverId?: string | undefined; toolName?: string | undefined },
  evidence: Evidence, root: Root) {
  function isOutcome(row: StoredEvent) { return row.event.type === 'tool.dispatch_recorded'; }
  const outcomes = rows.filter(isOutcome);
  if (outcomes.length !== 1) throw new Error('Upstream outcome is not unique');
  requireSource(outcomes[0]!, 'models', 'system', 'models');
  const result = toolDispatchRecordedDataSchema.parse(outcomes[0]!.event.data);
  if (result.requestId !== evidence.requestId || result.outcome !== 'responded' ||
      !['response_received', 'adapter_response_received'].includes(result.evidence) ||
      result.conversationId !== root.conversationId || result.turnId !== root.turnId ||
      result.callId !== decision.callId || result.serverId !== decision.serverId ||
      result.toolName !== decision.toolName) {
    throw new Error('Upstream outcome unconfirmed');
  }
  return result;
}
function requirePrivateResult(rows: StoredEvent[], evidence: Evidence,
  upstream: ReturnType<typeof toolDispatchRecordedDataSchema.parse>, root: Root) {
  const row = matchingRow(rows, 'agent.tool_call_finished', evidence.resultReference);
  requireSource(row, 'computer-bridge', 'agent', root.assistantId);
  const result = agentToolCallFinishedDataSchema.parse(row.event.data);
  if (result.status !== 'completed' || result.conversationId !== root.conversationId ||
      result.turnId !== root.turnId || result.callId !== upstream.callId ||
      result.serverId !== upstream.serverId || result.toolName !== upstream.toolName) {
    throw new Error('Private result does not match');
  }
}
function requireRootedHold(rows: StoredEvent[], root: Root, evidence: Evidence,
  toolPermitId: string) {
  function isReservation(row: StoredEvent) { return row.event.type === 'budget.reserved'; }
  function belongsToRoot(row: StoredEvent) {
    const data = z.object({ rootId: z.string().optional() }).parse(row.event.data);
    return data.rootId === root.rootId;
  }
  const reservations = rows.filter(isReservation);
  const rooted = reservations.filter(belongsToRoot);
  if (rooted.length !== 1) throw new Error('Other rooted spending remains');
  requireSource(rooted[0]!, 'models', 'system', 'models');
  const hold = z.object({ reservationId: z.string(), permitId: z.string(),
    amountCents: z.int().positive(), payingGroupId: z.string(),
    assistantId: z.string(), modelCall: z.object({ requesterId: z.string(),
      assistantId: z.string(), computerId: z.string(), generation: z.int(),
      conversationId: z.string(), turnId: z.string(), threadId: z.string(),
      payingGroupId: z.string() }) }).parse(rooted[0]!.event.data);
  const call = hold.modelCall;
  if (hold.reservationId !== evidence.reservationId || hold.permitId === toolPermitId ||
      hold.permitId !== hold.reservationId ||
      hold.payingGroupId !== root.payingGroupId || hold.assistantId !== root.assistantId) {
    throw new Error('Hold attribution changed');
  }
  requireModelCall(call, root);
  return { hold, position: rooted[0]!.sequence };
}
function requireModelCall(call: { requesterId: string; assistantId: string;
  computerId: string; generation: number; conversationId: string; turnId: string;
  threadId: string; payingGroupId: string }, root: Root) {
  if (call.requesterId !== root.requesterId || call.assistantId !== root.assistantId ||
      call.computerId !== root.computerId || call.generation !== root.generation ||
      call.conversationId !== root.conversationId || call.turnId !== root.turnId ||
      call.threadId !== root.threadId || call.payingGroupId !== root.payingGroupId) {
    throw new Error('Model spending changed');
  }
}
function requireSettlement(rows: StoredEvent[], root: Root, evidence: Evidence,
  toolPermitId: string) {
  const { hold, position } = requireRootedHold(rows, root, evidence, toolPermitId);
  function isSettlement(row: StoredEvent) { return row.event.type === 'budget.settled'; }
  function settlesReservation(row: StoredEvent) {
    const data = z.object({ reservationId: z.string() }).parse(row.event.data);
    return data.reservationId === evidence.reservationId;
  }
  const settlements = rows.filter(isSettlement);
  const matching = settlements.filter(settlesReservation);
  if (matching.length !== 1 || matching[0]!.sequence <= position) {
    throw new Error('Missing settlement');
  }
  requireSource(matching[0]!, 'models', 'system', 'models');
  const settled = z.object({ permitId: z.string(), settledCents: z.int().nonnegative(),
    outcome: z.string().optional() }).parse(matching[0]!.event.data);
  if (settled.permitId !== hold.permitId || settled.outcome !== undefined) {
    throw new Error('Settlement is uncertain');
  }
  return { heldCents: 0, settledCents: settled.settledCents };
}

/** Check saved company and money facts before releasing an occupied routine slot. */
export async function proveRoutineSuccess(store: EventStore, silo: string,
  evidence: Evidence, root: Root, definition: Definition, routineId: string,
  occurrenceId: string, budgetRows: StoredEvent[], deadline: number) {
  const decisionRows = await read(store, `decision-${evidence.requestId}`, silo, deadline);
  const conversationRows = await read(store, `conversation-${root.conversationId}`, silo, deadline);
  const { decision, release } = requireCompanyDecision(decisionRows, evidence, root,
    definition, routineId, occurrenceId);
  const upstream = requireUpstreamResult(decisionRows, decision, evidence, root);
  requirePrivateResult(conversationRows, evidence, upstream, root);
  const money = requireSettlement(budgetRows, root, evidence, release.permitId);
  return { ...money, resultReference: evidence.resultReference };
}
