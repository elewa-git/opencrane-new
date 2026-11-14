import { confirmDecisionAccess, type decisionActivity } from './decision-activity.ts';
import type { prepareLoadedMemory } from './loaded-memory.ts';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { decisionAuthorityFence, prepareAuthorityFacts, checkAuthorityPermissions, requirePermissions,
  type authorityFence }
  from './authority.ts';

export interface ToolAuthorityRequest {
  requesterId: string;
  assistantId: string;
  conversationId: string;
  serverId: string;
  conversationRows: StoredEvent[];
}

/** Prepare saved facts per dispatch. A prepared result never grants permission to send. */
async function prepareToolAuthority(store: EventStore, binding: Binding,
  request: ToolAuthorityRequest, deadline: number) {
  const head = await store.head(undefined, deadline);
  function include() {}
  const fresh = { head, deadline, include };
  const input = { requester: request.requesterId, assistant: request.assistantId,
    conversation: request.conversationId, resourceType: 'mcp_server',
    resourceId: request.serverId, conversationRows: request.conversationRows, fresh };
  const saved = await prepareAuthorityFacts(store, binding, input);
  const positions = new Map<string, number>();
  for (const subject of saved.subjects) positions.set(subject, head);
  async function confirm(current: Awaited<ReturnType<typeof decisionAuthorityFence>>) {
    const auth = memberAuthorisation(binding);
    const decisions = await checkAuthorityPermissions(auth, input);
    requirePermissions(decisions);
    await current();
  }
  return { subjects: saved.subjects, positions, confirm };
}


export interface PersonalToolAccessRequest extends ToolAuthorityRequest {
  activity: Pick<Awaited<ReturnType<typeof decisionActivity>>, 'confirm'>;
  needsApproval: boolean;
  memory: Pick<Awaited<ReturnType<typeof prepareLoadedMemory>>, 'confirm'>;
}

/** Keep preparation separate from the live checks used at each send boundary. */
export function personalToolAccess(store: EventStore, binding: Binding,
  request: PersonalToolAccessRequest) {
  let prepared: Awaited<ReturnType<typeof prepareToolAuthority>> | undefined;
  async function prepare(deadline: number) {
    prepared = await prepareToolAuthority(store, binding, request, deadline);
  }
  async function confirm() {
    if (!prepared) throw new Error('Personal authority not prepared');
    const snapshot = { deadline: Infinity, positions: prepared.positions };
    const current = await decisionAuthorityFence(store, performance.now(),
      prepared.subjects, request.requesterId, request.assistantId, undefined, snapshot);
    async function checkCurrent() {
      await current();
    }
    const authority = { include: current.include, head: current.head, deadline: current.deadline };
    const fresh = Object.assign(checkCurrent, authority);
    await confirmDecisionAccess(request.activity, current, request.needsApproval, true);
    await prepared.confirm(current);
    await request.memory.confirm(fresh, true);
    await confirmDecisionAccess(request.activity, current, request.needsApproval, true);
  }
  const preparation = { prepare };
  return Object.assign(confirm, preparation);
}

/** Keep the original access deadline for a server that needs no personal key. */
export function toolAccessWithinDeadline(store: EventStore, binding: Binding,
  request: ToolAuthorityRequest, fresh: Awaited<ReturnType<typeof authorityFence>>) {
  let prepared: Awaited<ReturnType<typeof prepareToolAuthority>> | undefined;
  async function prepare(deadline: number) {
    const originalDeadline = Math.min(deadline, fresh.deadline);
    prepared = await prepareToolAuthority(store, binding, request, originalDeadline);
    fresh.include(...prepared.subjects);
  }
  async function confirmOriginal() {
    await fresh();
    return false;
  }
  const snapshot = { include: fresh.include, head: fresh.head, deadline: fresh.deadline };
  const current = Object.assign(confirmOriginal, snapshot);
  async function confirm() {
    if (!prepared) throw new Error('Tool authority not prepared');
    await prepared.confirm(current);
  }
  const preparation = { prepare };
  return Object.assign(confirm, preparation);
}
