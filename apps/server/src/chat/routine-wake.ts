import { setTimeout as delay } from 'node:timers/promises';
import { computerSummary, type tokenIssuer } from '@opencrane/auth';
import { readBeforeDeadline, readStreamSummary, type EventStore } from '@opencrane/event-store';
import { resumeComputer } from '../../../ops/src/lifecycle.ts';
import { z } from 'zod';
import type { WebSocket } from 'ws';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type LinkIdentity = { computerId: string; assistantId: string; generation: number | undefined;
  socket: WebSocket };
const identity = z.object({ computerId: z.string(), assistantId: z.string(),
  generation: z.int().positive() });
const computerIdentity = identity.omit({ generation: true });
const wakeLimitMs = 20_000;

function requireLive(signal: AbortSignal, deadline: number) {
  if (performance.now() >= deadline || signal.aborted) {
    throw new Error('Routine computer unavailable');
  }
}

type Summary = ReturnType<typeof computerSummary.empty>;
type Facts = { lifecycle: Summary['lifecycle']; claim: Summary['claim'];
  control: Summary['control'] | undefined };

function recordedComputer(saved: Facts, assistantId: string) {
  const lifecycle = saved.lifecycle?.event.type;
  if (lifecycle !== 'computer.ready' && lifecycle !== 'computer.suspended') {
    throw new Error('Routine computer unavailable');
  }
  const recorded = identity.parse(saved.claim?.event.data);
  const current = computerIdentity.parse(saved.lifecycle?.event.data);
  if (recorded.assistantId !== assistantId || saved.control ||
      current.computerId !== recorded.computerId ||
      current.assistantId !== assistantId) {
    throw new Error('Routine computer unavailable');
  }
  return { recorded, lifecycle };
}

function sameComputer(saved: Facts, recorded: z.infer<typeof identity>) {
  const claim = identity.parse(saved.claim?.event.data);
  if (claim.computerId !== recorded.computerId ||
      claim.generation !== recorded.generation || saved.control) {
    throw new Error('Routine computer unavailable');
  }
  const lifecycle = saved.lifecycle;
  const state = lifecycle?.event.type;
  if (state === 'computer.ready') {
    const ready = identity.parse(lifecycle?.event.data);
    if (ready.computerId !== recorded.computerId ||
        ready.generation !== recorded.generation) {
      throw new Error('Routine computer unavailable');
    }
  } else if (state !== 'computer.resumed' && state !== 'computer.suspended') {
    throw new Error('Routine computer unavailable');
  }
  return state;
}

/** Resume only the saved computer, then use the bridge watcher's authenticated socket. */
export function createRoutineWake<Link extends LinkIdentity>(store: EventStore,
  silo: string, tokens: Tokens, watcherSignal: AbortSignal,
  connection: (computerId: string, assistantId: string,
    signal: AbortSignal, deadline: number) => Promise<Link>) {
  async function facts(assistantId: string, signal: AbortSignal, deadline: number) {
    function take(summary: ReturnType<typeof computerSummary.empty>) {
      return { lifecycle: summary.lifecycle, claim: summary.claim,
        grant: summary.grant, control: summary.control };
    }
    function readFacts() {
      const readDeadline = Math.min(deadline, performance.now() + 10_000);
      return readStreamSummary(store, silo, `computer-${assistantId}`,
        computerSummary, readDeadline, take);
    }
    return readBeforeDeadline(readFacts, deadline, signal);
  }

  async function waitReady(assistantId: string, recorded: z.infer<typeof identity>,
    signal: AbortSignal, deadline: number) {
    while (true) {
      requireLive(signal, deadline);
      const saved = await facts(assistantId, signal, deadline);
      requireLive(signal, deadline);
      const state = sameComputer(saved, recorded);
      if (state === 'computer.ready') return;
      const remaining = deadline - performance.now();
      await delay(Math.min(100, remaining), undefined, { signal });
    }
  }

  async function connectedReady(assistantId: string, recorded: z.infer<typeof identity>,
    signal: AbortSignal, deadline: number) {
    function openConnection() {
      return connection(recorded.computerId, assistantId, signal, deadline);
    }
    const link = await readBeforeDeadline(openConnection, deadline, signal);
    requireLive(signal, deadline);
    if (link.computerId !== recorded.computerId ||
        link.assistantId !== assistantId || link.generation !== recorded.generation ||
        link.socket.readyState !== link.socket.OPEN) {
      throw new Error('Routine computer unavailable');
    }
    const after = await facts(assistantId, signal, deadline);
    requireLive(signal, deadline);
    if (sameComputer(after, recorded) !== 'computer.ready') {
      throw new Error('Routine computer unavailable');
    }
    return { link, generation: recorded.generation };
  }

  async function wake(assistantId: string, signal?: AbortSignal) {
    const deadline = performance.now() + wakeLimitMs;
    const timerSignal = AbortSignal.timeout(wakeLimitMs);
    const sources = signal ? [watcherSignal, signal, timerSignal] : [watcherSignal, timerSignal];
    const wakeSignal = AbortSignal.any(sources);
    try {
      requireLive(wakeSignal, deadline);
      const initial = await facts(assistantId, wakeSignal, deadline);
      requireLive(wakeSignal, deadline);
      const { recorded, lifecycle } = recordedComputer(initial, assistantId);
      if (lifecycle === 'computer.suspended') {
        requireLive(wakeSignal, deadline);
        await resumeComputer(store, tokens, silo, assistantId, recorded,
          { signal: wakeSignal, deadline });
      }
      await waitReady(assistantId, recorded, wakeSignal, deadline);
      return await connectedReady(assistantId, recorded, wakeSignal, deadline);
    } catch {
      throw new Error('Routine computer unavailable');
    }
  }
  return wake;
}
