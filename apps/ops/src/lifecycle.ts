import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IssuedToken, tokenIssuer } from '@opencrane/auth';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { conversationCreatedDataSchema, type EventEnvelope } from '@opencrane/events';
import { readEvents } from '@opencrane/projections';
import { registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import type { SandboxClient, SandboxState } from './kubernetes.ts';

type Store = Pick<EventStore, 'readStream' | 'append'>;
type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
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
  // Read the winner, including after deduplication or a lost conditional append.
  return (await history(store, subject)).at(-1)!.event;
}

export function lifecycleHandlers(store: Store) {
  const createAssistant = registerHandler('create-assistant', async (event) => {
    const memberId = field(event.data, 'memberId');
    const assistantId = stable('personal', event.silo, memberId);
    const subject = `assistant-${assistantId}`;
    const events = await history(store, subject);
    if (events.length) return;
    await append(store, event, events, 'assistant.created', subject,
      { assistantId, ownerId: memberId, kind: 'personal' });
  });
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
async function states(store: EventStore, silo: string): Promise<ComputerState[]> {
  // ponytail: scan the event stream for the prototype; index when silo volume warrants it.
  const computers = new Map<string, ComputerState>();
  const head = await store.head();
  if (!head) return [];
  for await (const { event } of readEvents(store, 1, head)) {
    if (event.silo !== silo || !isLifecycleEvent(event)) continue;
    const assistantId = field(event.data, 'assistantId');
    const computerId = field(event.data, 'computerId');
    const current = computers.get(assistantId) ?? { assistantId, computerId, latest: event };
    current.latest = event;
    if (event.type === 'computer.ready') current.ready = event;
    computers.set(assistantId, current);
  }
  return [...computers.values()];
}

export async function suspendComputer(store: Store, state: ComputerState): Promise<EventEnvelope> {
  const subject = `computer-${state.assistantId}`;
  const events = await history(store, subject);
  const current = events.findLast(r => isLifecycleEvent(r.event))!.event;
  const busy = new Set<string>();
  for (const { event } of events) {
    if (event.type === 'computer.turn_started') busy.add(field(event.data, 'turnId'));
    if (event.type === 'computer.turn_closed') busy.delete(field(event.data, 'turnId'));
  }
  if (current.id !== state.latest.id || current.type !== 'computer.ready' || busy.size) return current;
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

async function reconcileComputer(store: EventStore, kube: SandboxClient,
  state: ComputerState, tokens: Tokens, sink: CredentialSink, idleMs: number) {
  const subject = `computer-${state.assistantId}`;
  const events = await history(store, subject);
  if (events.findLast(r => isLifecycleEvent(r.event))?.event.id !== state.latest.id) return;
  const data = { assistantId: state.assistantId, computerId: state.computerId };
  if (state.latest.type === 'computer.suspended') {
    await kube.mode(state.computerId, 'Suspended');
    return;
  }
  if (['computer.lost', 'computer.retired'].includes(state.latest.type)) return;
  if (state.latest.type === 'computer.claimed') await kube.claim(state.computerId, state.assistantId);
  const sandbox = await kube.state(state.computerId);
  // Missing bindings follow the loss reaction, which re-claims and rotates the grant.
  if (!sandbox) {
    await observeReady(store, state, events, sandbox, tokens, sink, idleMs);
    return;
  }
  if (['computer.claimed', 'computer.resumed'].includes(state.latest.type) && sandbox.podUid && sandbox.podUid === readyPodUid(state)) {
    await kube.mode(state.computerId, 'Suspended');
    return;
  }
  await kube.mode(state.computerId, 'Running');
  if (['computer.claimed', 'computer.resumed'].includes(state.latest.type)) {
    if (sandbox.ready && sandbox.podUid) {
      await sink(state.computerId, await tokens.computer({ silo: state.latest.silo, ...data, generation: generation(events),
        tokenId: field(state.latest.data, 'tokenId') }));
      await append(store, state.latest, events, 'computer.ready', subject,
        { ...data, generation: generation(events), podUid: sandbox.podUid, sandboxUid: sandbox.uid });
    }
    return;
  }
  await observeReady(store, state, events, sandbox, tokens, sink, idleMs);
}

async function lastActivity(store: EventStore, silo: string, assistantId: string): Promise<number> {
  const conversations = new Set<string>(), openTurnIds = new Set<string>();
  let time = 0;
  for await (const { event } of readEvents(store, 1, await store.head())) {
    if (event.silo !== silo) continue;
    if (event.type === 'conversation.created') {
      const created = conversationCreatedDataSchema.parse(event.data);
      if (created.mode === 'agent_session' && created.assistantId === assistantId) {
        conversations.add(event.subject);
      }
    }
    if (!conversations.has(event.subject)) continue;
    if (event.type === 'message.posted') openTurnIds.add(event.id);
    // A turn id is the id of the message.posted event that started it.
    if (['agent.turn_completed', 'agent.turn_failed'].includes(event.type)) {
      openTurnIds.delete(field(event.data, 'turnId'));
    }
    time = Math.max(time, Date.parse(event.time));
  }
  // A posted turn without a terminal event keeps this computer active.
  return openTurnIds.size ? Infinity : time;
}

async function observeReady(store: EventStore, state: ComputerState, events: StoredEvent[],
  sandbox: SandboxState | undefined, tokens: Tokens, sink: CredentialSink, idleMs: number) {
  const subject = `computer-${state.assistantId}`;
  const data = { assistantId: state.assistantId, computerId: state.computerId };
  const previousPodUid = readyPodUid(state);
  if (!sandbox?.podUid || (previousPodUid !== undefined && sandbox.podUid !== previousPodUid)) {
    await append(store, state.latest, events, 'computer.lost', subject, data);
  } else if (await isIdle(store, state, idleMs)) {
    await suspendComputer(store, state);
  } else if (sandbox.ready) {
    const grant = events.findLast(({ event }) => ['computer.claimed', 'computer.resumed'].includes(event.type))!.event;
    await sink(state.computerId, await tokens.computer({ silo: state.latest.silo, ...data, generation: generation(events), tokenId: field(grant.data, 'tokenId') }));
    // Upgrade old readiness events without inventing a Pod loss.
    if (!previousPodUid || (typeof state.ready?.data === 'object' && state.ready.data !== null && !('generation' in state.ready.data))) await append(store, state.latest, events, 'computer.ready', subject,
      { ...data, generation: generation(events), podUid: sandbox.podUid, sandboxUid: sandbox.uid });
  }
}

async function isIdle(store: EventStore, state: ComputerState, idleMs: number): Promise<boolean> {
  if (!state.ready) {
    return false;
  }
  // Do not count the event scan itself as idle time.
  const checkedAt = Date.now();
  const lastActivityAt = await lastActivity(store, state.latest.silo, state.assistantId);
  const idleSince = Math.max(Date.parse(state.ready.time), lastActivityAt);
  return checkedAt - idleSince >= idleMs;
}

export function watchComputers(store: EventStore, kube: SandboxClient,
  tokens: Tokens, sink: CredentialSink, silo: string, idleMs: number, signal: AbortSignal) {
  const logger = createLogger('computer-lifecycle');
  return (async () => {
    while (!signal.aborted) {
      for (const state of await states(store, silo)) {
        try {
          await reconcileComputer(store, kube, state, tokens, sink, idleMs);
        } catch (error) {
          logger.error({ err: error, computerId: state.computerId }, 'Computer reconciliation failed; retrying next poll');
        }
      }
      await delay(250, undefined, { signal }).catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
      });
    }
  })();
}
