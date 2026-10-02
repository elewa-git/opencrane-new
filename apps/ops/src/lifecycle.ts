import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IssuedToken, tokenIssuer } from '@opencrane/auth';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { readEvents } from '@opencrane/projections';
import { registerHandler } from '@opencrane/handlers';
import type { SandboxClient } from './kubernetes.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type CredentialSink = (computerId: string, token: IssuedToken) => void;

function field(data: unknown, name: string): string {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid lifecycle event');
  const result: unknown = Reflect.get(data, name);
  if (typeof result !== 'string') throw new Error(`Missing lifecycle ${name}`);
  return result;
}
function numberField(data: unknown, name: string): number {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid lifecycle event');
  const result: unknown = Reflect.get(data, name);
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) throw new Error(`Missing lifecycle ${name}`);
  return result;
}
function stable(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}
async function history(store: Pick<EventStore, 'readStream'>, subject: string) {
  const result: StoredEvent[] = [];
  for await (const item of store.readStream(subject)) result.push(item);
  return result;
}
async function append(store: Pick<EventStore, 'readStream' | 'append'>, trigger: EventEnvelope,
  type: string, subject: string, data: Record<string, unknown>) {
  const events = await history(store, subject);
  const result = await store.append({ expectedSequence: events.at(-1)?.sequence ?? 0, event: {
    id: randomUUID(), commandId: `${trigger.id}:${type}`, type, subject, silo: trigger.silo,
    source: 'opencrane-lifecycle', time: new Date().toISOString(),
    principal: { kind: 'system', id: 'computer-lifecycle' }, data,
  } });
  if (result.status !== 'appended') throw new Error(`Lifecycle append failed: ${result.status}`);
}

export function lifecycleHandlers(store: Pick<EventStore, 'readStream' | 'append'>,
  kube: Pick<SandboxClient, 'claim'>, tokens: Tokens, onToken: CredentialSink = () => undefined) {
  const createAssistant = registerHandler('create-assistant', async (event) => {
    const memberId = field(event.data, 'memberId');
    const assistantId = stable('personal', event.silo, memberId);
    await append(store, event, 'assistant.created', `assistant-${assistantId}`,
      { assistantId, ownerId: memberId, kind: 'personal' });
  });
  const claimComputer = registerHandler('claim-computer', async (event) => {
    const assistantId = field(event.data, 'assistantId');
    const subject = `computer-${assistantId}`;
    const events = await history(store, subject);
    if (events.some(({ event: item }) => item.commandId === `${event.id}:computer.claimed`)) return;
    const previous = events.findLast(({ event: item }) => item.type === 'computer.claimed');
    const computerId = previous ? field(previous.event.data, 'computerId')
      : stable('computer', event.silo, assistantId);
    const generation = previous ? numberField(previous.event.data, 'generation') + 1 : 1;
    const sandboxUid = await kube.claim(computerId, assistantId);
    const token = await tokens.computer({ silo: event.silo, computerId, assistantId });
    onToken(computerId, token);
    await append(store, event, 'computer.claimed', subject,
      { assistantId, computerId, sandboxUid, generation, tokenId: token.id });
  });
  return [createAssistant, claimComputer] as const;
}

export interface ComputerState {
  assistantId: string; computerId: string; latest: EventEnvelope; ready?: EventEnvelope;
}
async function states(store: EventStore, silo: string): Promise<ComputerState[]> {
  // ponytail: scan the event stream for the prototype; use a durable timer index when silo event volume warrants it.
  const computers = new Map<string, ComputerState>();
  const head = await store.head();
  if (!head) return [];
  for await (const { event } of readEvents(store, 1, head)) {
    if (event.silo !== silo || !event.type.startsWith('computer.')) continue;
    const assistantId = field(event.data, 'assistantId');
    const computerId = field(event.data, 'computerId');
    const current = computers.get(assistantId) ?? { assistantId, computerId, latest: event };
    current.latest = event;
    if (event.type === 'computer.ready') current.ready = event;
    computers.set(assistantId, current);
  }
  return [...computers.values()];
}

export async function suspendComputer(store: EventStore, kube: Pick<SandboxClient, 'mode'>,
  state: ComputerState): Promise<void> {
  await kube.mode(state.computerId, 'Suspended');
  await append(store, state.latest, 'computer.suspended', `computer-${state.assistantId}`,
    { assistantId: state.assistantId, computerId: state.computerId });
}

export async function resumeComputer(store: EventStore, kube: Pick<SandboxClient, 'mode'>, tokens: Tokens,
  silo: string, assistantId: string): Promise<IssuedToken> {
  const state = (await states(store, silo)).find((item) => item.assistantId === assistantId);
  if (!state || state.latest.type !== 'computer.suspended') throw new Error('Computer is not suspended');
  const token = await tokens.computer({ silo, computerId: state.computerId, assistantId });
  await kube.mode(state.computerId, 'Running');
  await append(store, state.latest, 'computer.resumed', `computer-${assistantId}`,
    { assistantId, computerId: state.computerId, tokenId: token.id });
  return token;
}

async function reconcileComputer(store: EventStore, kube: Pick<SandboxClient, 'state' | 'mode'>,
  state: ComputerState, idleMs: number) {
  if (['computer.suspended', 'computer.lost', 'computer.retired'].includes(state.latest.type)) return;
  const sandbox = await kube.state(state.computerId);
  if (state.latest.type === 'computer.claimed' || state.latest.type === 'computer.resumed') {
    if (sandbox?.ready) await append(store, state.latest, 'computer.ready', `computer-${state.assistantId}`,
      { assistantId: state.assistantId, computerId: state.computerId });
    return;
  }
  const restarted = sandbox?.readyChangedAt && state.ready
    && Date.parse(sandbox.readyChangedAt) > Date.parse(state.ready.time);
  if (!sandbox?.ready || restarted) {
    await append(store, state.latest, 'computer.lost', `computer-${state.assistantId}`,
      { assistantId: state.assistantId, computerId: state.computerId });
  } else if (state.ready && Date.now() - Date.parse(state.ready.time) >= idleMs) {
    await suspendComputer(store, kube, state);
  }
}

export function watchComputers(store: EventStore, kube: Pick<SandboxClient, 'state' | 'mode'>,
  silo: string, idleMs: number, signal: AbortSignal) {
  return (async () => {
    while (!signal.aborted) {
      for (const state of await states(store, silo)) {
        await reconcileComputer(store, kube, state, idleMs);
      }
      await delay(250, undefined, { signal }).catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
      });
    }
  })();
}
