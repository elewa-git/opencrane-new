import { setTimeout as delay } from 'node:timers/promises';
import { computerSummary, type tokenIssuer } from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
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

function aborted(signal: AbortSignal) {
  return signal.aborted;
}
function requireLive(signals: AbortSignal[], deadline: number) {
  if (performance.now() >= deadline || signals.some(aborted)) {
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
  connection: (computerId: string, assistantId: string) => Promise<Link>) {
  async function facts(assistantId: string) {
    function take(summary: ReturnType<typeof computerSummary.empty>) {
      return { lifecycle: summary.lifecycle, claim: summary.claim,
        grant: summary.grant, control: summary.control };
    }
    return readStreamSummary(store, silo, `computer-${assistantId}`,
      computerSummary, performance.now() + 10_000, take);
  }

  async function waitReady(assistantId: string, recorded: z.infer<typeof identity>,
    signals: AbortSignal[], deadline: number) {
    while (true) {
      requireLive(signals, deadline);
      const saved = await facts(assistantId);
      requireLive(signals, deadline);
      const state = sameComputer(saved, recorded);
      if (state === 'computer.ready') return;
      await delay(100, undefined, { signal: signals[0] });
    }
  }

  async function connectedReady(assistantId: string, recorded: z.infer<typeof identity>,
    signals: AbortSignal[], deadline: number) {
    const link = await connection(recorded.computerId, assistantId);
    requireLive(signals, deadline);
    if (link.computerId !== recorded.computerId ||
        link.assistantId !== assistantId || link.generation !== recorded.generation ||
        link.socket.readyState !== link.socket.OPEN) {
      throw new Error('Routine computer unavailable');
    }
    const after = await facts(assistantId);
    requireLive(signals, deadline);
    if (sameComputer(after, recorded) !== 'computer.ready') {
      throw new Error('Routine computer unavailable');
    }
    return { link, generation: recorded.generation };
  }

  async function wake(assistantId: string, signal?: AbortSignal) {
    const signals = signal ? [watcherSignal, signal] : [watcherSignal];
    const deadline = performance.now() + wakeLimitMs;
    try {
      requireLive(signals, deadline);
      const initial = await facts(assistantId);
      requireLive(signals, deadline);
      const { recorded, lifecycle } = recordedComputer(initial, assistantId);
      if (lifecycle === 'computer.suspended') {
        requireLive(signals, deadline);
        await resumeComputer(store, tokens, silo, assistantId, recorded);
      }
      await waitReady(assistantId, recorded, signals, deadline);
      return await connectedReady(assistantId, recorded, signals, deadline);
    } catch {
      throw new Error('Routine computer unavailable');
    }
  }
  return wake;
}
