import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IssuedToken, tokenIssuer } from '@opencrane/auth';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { conversationCreatedDataSchema, memberJoinedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { readEvents } from '@opencrane/projections';
import { registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import type { SandboxClient, SandboxState } from './kubernetes.ts';

type Store = Pick<EventStore, 'readStream' | 'append'>;
type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type IdleCheck = () => Promise<boolean>;
export type CredentialSink = (computerId: string, token: IssuedToken) => Promise<void>;

export function field(data: unknown, name: string): string {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid lifecycle event');
  const result: unknown = Reflect.get(data, name);
  if (typeof result !== 'string') throw new Error(`Missing lifecycle ${name}`);
  return result;
}
function stable(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}
export async function history(store: Pick<EventStore, 'readStream'>, subject: string) {
  const result: StoredEvent[] = [];
  for await (const item of store.readStream(subject)) result.push(item);
  return result;
}
function isLifecycleEvent(event: EventEnvelope): boolean {
  return ['computer.claimed', 'computer.ready', 'computer.suspended', 'computer.resumed', 'computer.lost', 'computer.retired'].includes(event.type);
}
function generation(events: StoredEvent[]): number {
  const data = events.findLast(({ event }) => event.type === 'computer.claimed')?.event.data;
  const value: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'generation') : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Missing computer generation');
  return value;
}
async function append(store: Store, trigger: EventEnvelope, events: StoredEvent[],
  type: string, subject: string, data: Record<string, unknown>) {
  const result = await store.append({ expectedSequence: events.at(-1)?.sequence ?? 0, event: {
    id: randomUUID(), commandId: `${trigger.id}:${type}`, type, subject, silo: trigger.silo,
    source: 'opencrane-lifecycle', time: new Date().toISOString(),
    principal: { kind: 'system', id: 'computer-lifecycle' }, data,
  } });
  if (result.status === 'unavailable') throw new Error('Lifecycle append unavailable', { cause: result.cause });
  if (result.status === 'rejected') throw new Error('Lifecycle append rejected');
  // Read the newest stored event. A repeated command or a competing append may have kept
  // another event instead of the one this handler tried to write.
  return (await history(store, subject)).at(-1)!.event;
}

export function lifecycleHandlers(store: Store) {
  async function createPersonalAssistant(event: EventEnvelope) {
    if (event.type === 'member.joined') {
      const joined = memberJoinedDataSchema.parse(event.data);
      if (joined.personalAssistant === 'none') {
        return;
      }
    }
    const memberId = field(event.data, 'memberId');
    const assistantId = stable('personal', event.silo, memberId);
    const subject = `assistant-${assistantId}`;
    const events = await history(store, subject);
    if (events.length) {
      return;
    }
    await append(store, event, events, 'assistant.created', subject,
      { assistantId, ownerId: memberId, kind: 'personal' });
  }
  const createAssistant = registerHandler('create-assistant', createPersonalAssistant);
  const claimComputer = registerHandler('claim-computer', async (event) => {
    const assistantId = field(event.data, 'assistantId');
    const subject = `computer-${assistantId}`;
    const events = await history(store, subject);
    if (events.length && events.findLast(r => isLifecycleEvent(r.event))?.event.id !== event.id) return;
    const generation = events.filter(({ event: item }) => item.type === 'computer.claimed').length + 1;
    await append(store, event, events, 'computer.claimed', subject,
      { assistantId, computerId: stable('computer', event.silo, assistantId), generation, tokenId: `token:${randomUUID()}` });
  });
  return [createAssistant, claimComputer] as const;
}

export interface ComputerState {
  assistantId: string; computerId: string; latest: EventEnvelope; ready?: EventEnvelope;
}
function readyPodUid(state: ComputerState): string | undefined {
  const data = state.ready?.data;
  return typeof data === 'object' && data !== null && 'podUid' in data && typeof data.podUid === 'string'
    ? data.podUid : undefined;
}
interface ComputerActivity {
  time: number;
  openTurns: Set<string>;
}
interface ComputerWatchState {
  position: number;
  computers: Map<string, ComputerState>;
  conversations: Map<string, string>;
  activity: Map<string, ComputerActivity>;
  histories: Map<string, StoredEvent[]>;
}
const IDLE_CHECK_INTERVAL_MS = 30_000;
const SUSPENDED_CHECK_INTERVAL_MS = 60_000;

function recordActivity(snapshot: ComputerWatchState, event: EventEnvelope) {
  if (event.type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(event.data);
    if (created.mode === 'agent_session') {
      snapshot.conversations.set(event.subject, created.assistantId);
    }
  }
  const assistantId = snapshot.conversations.get(event.subject);
  if (!assistantId) return;
  const activity = snapshot.activity.get(assistantId) ?? { time: 0, openTurns: new Set<string>() };
  if (event.type === 'message.posted') activity.openTurns.add(event.id);
  if (['agent.turn_completed', 'agent.turn_failed'].includes(event.type)) {
    activity.openTurns.delete(field(event.data, 'turnId'));
  }
  activity.time = Math.max(activity.time, Date.parse(event.time));
  snapshot.activity.set(assistantId, activity);
}

async function updateComputers(store: EventStore, kube: SandboxClient,
  silo: string, snapshot: ComputerWatchState) {
  const head = await store.head();
  for await (const row of readEvents(store, snapshot.position + 1, head)) {
    const { event, sequence } = row;
    if (event.silo === silo) {
      recordActivity(snapshot, event);
      if (event.subject.startsWith('computer-')) {
        const events = snapshot.histories.get(event.subject) ?? [];
        events.push(row);
        snapshot.histories.set(event.subject, events);
      }
      if (isLifecycleEvent(event)) {
        const assistantId = field(event.data, 'assistantId');
        const computerId = field(event.data, 'computerId');
        if (['computer.lost', 'computer.claimed'].includes(event.type)) {
          kube.forgetMode(computerId);
        }
        const previous = snapshot.computers.get(assistantId);
        const current: ComputerState = { ...previous, assistantId, computerId, latest: event };
        if (event.type === 'computer.ready') current.ready = event;
        snapshot.computers.set(assistantId, current);
      }
    }
    // Advance only after processing each event so a failed read can retry the rest.
    snapshot.position = sequence;
  }
}

function hasOpenComputerTurns(events: StoredEvent[]): boolean {
  const openTurns = new Set<string>();
  for (const { event } of events) {
    if (event.type === 'computer.claimed') openTurns.clear();
    if (event.type === 'computer.turn_started') {
      openTurns.add(field(event.data, 'turnId'));
    }
    if (event.type === 'computer.turn_closed') {
      openTurns.delete(field(event.data, 'turnId'));
    }
  }
  return openTurns.size > 0;
}

export async function suspendComputer(store: Store, state: ComputerState): Promise<EventEnvelope> {
  const subject = `computer-${state.assistantId}`;
  const events = await history(store, subject);
  const current = events.findLast(r => isLifecycleEvent(r.event))!.event;
  if (current.id !== state.latest.id || current.type !== 'computer.ready'
    || hasOpenComputerTurns(events)) return current;
  return append(store, current, events, 'computer.suspended', subject,
    { assistantId: state.assistantId, computerId: state.computerId });
}

export async function resumeComputer(store: Store, tokens: Tokens,
  silo: string, assistantId: string): Promise<IssuedToken> {
  const subject = `computer-${assistantId}`;
  let events = await history(store, subject);
  const current = events.findLast(r => isLifecycleEvent(r.event))?.event;
  if (!current || current.silo !== silo) throw new Error('Computer not found');
  if (current.type === 'computer.suspended') {
    await append(store, current, events, 'computer.resumed', subject,
      { assistantId, computerId: field(current.data, 'computerId'), generation: generation(events), tokenId: `token:${randomUUID()}` });
    events = await history(store, subject);
  }
  const latest = events.findLast(r => isLifecycleEvent(r.event))!.event;
  if (!['computer.resumed', 'computer.ready'].includes(latest.type)) throw new Error('Computer is not running');
  const grant = events.findLast(({ event }) => ['computer.claimed', 'computer.resumed'].includes(event.type))!.event;
  return tokens.computer({ generation: generation(events), silo, computerId: field(grant.data, 'computerId'), assistantId,
    tokenId: field(grant.data, 'tokenId') });
}

async function suspendSandbox(kube: SandboxClient, state: ComputerState,
  allowUpgrade: boolean, checkDrift: boolean) {
  const sandbox = await kube.state(state.computerId);
  if (!sandbox) await kube.claim(state.computerId, state.assistantId);
  if (checkDrift && sandbox && !sandbox.suspended) kube.forgetMode(state.computerId);
  await kube.mode(state.computerId, 'Suspended');
  if (sandbox?.outdated && sandbox.suspended && !sandbox.podUid && allowUpgrade) {
    await kube.upgrade(state.computerId, state.assistantId);
    return false;
  }
  return sandbox?.suspended === true;
}

async function reconcileComputer(store: EventStore, kube: SandboxClient,
  state: ComputerState, events: StoredEvent[], tokens: Tokens, sink: CredentialSink,
  checkIdle: IdleCheck, checkSuspended: boolean) {
  if (events.findLast(r => isLifecycleEvent(r.event))?.event.id !== state.latest.id) return true;
  const allowUpgrade = !hasOpenComputerTurns(events);
  if (state.latest.type === 'computer.suspended') {
    return suspendSandbox(kube, state, allowUpgrade, checkSuspended);
  }
  if (['computer.lost', 'computer.retired'].includes(state.latest.type)) return true;
  if (state.latest.type === 'computer.ready') {
    await reconcileReadyComputer(store, kube, state, events, tokens, sink, checkIdle);
    return true;
  }
  await reconcileStartingComputer(store, kube, state, events, tokens, sink, checkIdle,
    allowUpgrade);
  return true;
}

async function reconcileReadyComputer(store: EventStore, kube: SandboxClient,
  state: ComputerState, events: StoredEvent[], tokens: Tokens, sink: CredentialSink,
  checkIdle: IdleCheck) {
  const sandbox = await kube.state(state.computerId);
  if (sandbox && !sandbox.outdated) {
    if (sandbox.suspended) kube.forgetMode(state.computerId);
    await kube.mode(state.computerId, 'Running');
  }
  // Keep a running computer until its next committed suspension.
  await observeReady(store, state, events, sandbox, tokens, sink, checkIdle);
}

async function reconcileStartingComputer(store: EventStore, kube: SandboxClient,
  state: ComputerState, events: StoredEvent[], tokens: Tokens, sink: CredentialSink,
  checkIdle: IdleCheck, allowUpgrade: boolean) {
  if (state.latest.type === 'computer.claimed') {
    await kube.claim(state.computerId, state.assistantId);
  }
  const sandbox = await kube.state(state.computerId);
  if (sandbox?.outdated && sandbox.suspended && !sandbox.podUid && allowUpgrade) {
    await kube.upgrade(state.computerId, state.assistantId);
    // Re-read on the next pass. Admission may have changed while the update was in flight.
    return;
  }
  // Repair missing bindings through the loss reaction, which rotates the computer grant.
  if (!sandbox) {
    await observeReady(store, state, events, sandbox, tokens, sink, checkIdle);
    return;
  }
  if (sandbox.podUid && sandbox.podUid === readyPodUid(state)) {
    await kube.mode(state.computerId, 'Suspended');
    return;
  }
  if (sandbox.suspended) kube.forgetMode(state.computerId);
  await kube.mode(state.computerId, 'Running');
  if (sandbox.ready && sandbox.podUid) {
    const data = { assistantId: state.assistantId, computerId: state.computerId };
    const credentialRequest = {
      silo: state.latest.silo, ...data, generation: generation(events),
      tokenId: field(state.latest.data, 'tokenId'),
    };
    const credential = await tokens.computer(credentialRequest);
    await sink(state.computerId, credential);
    const readyData = {
      ...data, generation: generation(events), podUid: sandbox.podUid, sandboxUid: sandbox.uid,
    };
    await append(store, state.latest, events, 'computer.ready', `computer-${state.assistantId}`,
      readyData);
  }
}

async function observeReady(store: EventStore, state: ComputerState, events: StoredEvent[],
  sandbox: SandboxState | undefined, tokens: Tokens, sink: CredentialSink, checkIdle: IdleCheck) {
  const subject = `computer-${state.assistantId}`;
  const data = { assistantId: state.assistantId, computerId: state.computerId };
  const previousPodUid = readyPodUid(state);
  if (!sandbox?.podUid || (previousPodUid !== undefined && sandbox.podUid !== previousPodUid)) {
    await append(store, state.latest, events, 'computer.lost', subject, data);
  } else if (await checkIdle()) {
    await suspendComputer(store, state);
  } else if (sandbox.ready) {
    const grant = events.findLast(({ event }) => ['computer.claimed', 'computer.resumed'].includes(event.type))!.event;
    await sink(state.computerId, await tokens.computer({ silo: state.latest.silo, ...data, generation: generation(events), tokenId: field(grant.data, 'tokenId') }));
    // Upgrade old readiness events without inventing a Pod loss.
    if (!previousPodUid || (typeof state.ready?.data === 'object' && state.ready.data !== null && !('generation' in state.ready.data))) await append(store, state.latest, events, 'computer.ready', subject,
      { ...data, generation: generation(events), podUid: sandbox.podUid, sandboxUid: sandbox.uid });
  }
}

function isIdle(state: ComputerState, activity: ComputerActivity | undefined,
  idleMs: number, checkedAt: number): boolean {
  if (!state.ready || activity?.openTurns.size) return false;
  const idleSince = Math.max(Date.parse(state.ready.time), activity?.time ?? 0);
  return checkedAt - idleSince >= idleMs;
}

function skipComputerCheck(state: ComputerState, stable: boolean, eventsMoved: boolean,
  lastCheckAt: number, checkedAt: number): boolean {
  if (!stable) return false;
  if (['computer.lost', 'computer.retired'].includes(state.latest.type)) return true;
  const elapsedMs = checkedAt - lastCheckAt;
  if (state.latest.type === 'computer.suspended') {
    return elapsedMs < SUSPENDED_CHECK_INTERVAL_MS;
  }
  return state.latest.type === 'computer.ready' && !eventsMoved &&
    elapsedMs < IDLE_CHECK_INTERVAL_MS;
}

export function watchComputers(store: EventStore, kube: SandboxClient,
  tokens: Tokens, sink: CredentialSink, silo: string, idleMs: number, signal: AbortSignal) {
  const logger = createLogger('computer-lifecycle');
  const snapshot: ComputerWatchState = {
    position: 0, computers: new Map(), conversations: new Map(), activity: new Map(),
    histories: new Map(),
  };
  const applied = new Map<string, string>();
  const idleChecks = new Map<string, number>();
  const podChecks = new Map<string, number>();
  const retries = new Map<string, { eventId: string; delayMs: number; nextAttemptAt: number }>();
  const inFlight = new Map<string, Promise<void>>();
  let refresh: Promise<void> | undefined;
  async function refreshComputers() {
    if (!refresh) refresh = updateComputers(store, kube, silo, snapshot);
    const currentRefresh = refresh;
    try {
      await currentRefresh;
    } finally {
      if (refresh === currentRefresh) refresh = undefined;
    }
  }
  async function checkComputer(state: ComputerState, stable: boolean, checkedAt: number) {
    const retry = retries.get(state.computerId);
    async function checkIdleness() {
      const checkedAt = Date.now();
      const lastCheckAt = idleChecks.get(state.computerId) ?? -Infinity;
      if (checkedAt - lastCheckAt < IDLE_CHECK_INTERVAL_MS) return false;
      idleChecks.set(state.computerId, checkedAt);
      // Read messages that arrived during the Kubernetes call before deciding to suspend.
      await refreshComputers();
      const activity = snapshot.activity.get(state.assistantId);
      return isIdle(state, activity, idleMs, checkedAt);
    }
    try {
      const storedEvents = snapshot.histories.get(`computer-${state.assistantId}`) ?? [];
      const events = [...storedEvents];
      const checkSuspended = stable && state.latest.type === 'computer.suspended';
      const settled = await reconcileComputer(store, kube, state, events, tokens, sink,
        checkIdleness, checkSuspended);
      retries.delete(state.computerId);
      if (settled === false) applied.delete(state.computerId);
      else applied.set(state.computerId, state.latest.id);
      podChecks.set(state.computerId, checkedAt);
    } catch (error) {
      applied.delete(state.computerId);
      const retryState = computerRetry(state.latest.id, retry?.delayMs);
      retries.set(state.computerId, retryState);
      const logFields = { err: error, computerId: state.computerId, retryInMs: retryState.delayMs };
      logger.error(logFields, 'Computer reconciliation failed; waiting before retry');
    } finally {
      inFlight.delete(state.computerId);
    }
  }
  async function pollComputers() {
    try {
      while (!signal.aborted) {
        const previousPosition = snapshot.position;
        await refreshComputers();
        const eventsMoved = snapshot.position !== previousPosition;
        for (const state of snapshot.computers.values()) {
          if (inFlight.has(state.computerId)) continue;
          const previous = applied.get(state.computerId);
          const stable = previous === state.latest.id;
          const checkedAt = Date.now();
          const retry = retries.get(state.computerId);
          if (retry?.eventId === state.latest.id && checkedAt < retry.nextAttemptAt) continue;
          if (retry && retry.eventId !== state.latest.id) retries.delete(state.computerId);
          const lastPodCheck = podChecks.get(state.computerId) ?? -Infinity;
          if (skipComputerCheck(state, stable, eventsMoved, lastPodCheck, checkedAt)) continue;
          // Run each computer independently. A slow upgrade must not hold up another resume.
          const work = checkComputer(state, stable, checkedAt);
          inFlight.set(state.computerId, work);
        }
        await delay(250, undefined, { signal }).catch(ignoreStoppedPoll);
      }
    } finally {
      await Promise.all(inFlight.values());
    }
  }
  return pollComputers();
}

function computerRetry(eventId: string, previousDelayMs = 500) {
  const delayMs = Math.min(previousDelayMs * 2, 60_000);
  const nextAttemptAt = Date.now() + delayMs;
  return { eventId, delayMs, nextAttemptAt };
}

function ignoreStoppedPoll(error: unknown) {
  if (!(error instanceof Error && error.name === 'AbortError')) throw error;
}
