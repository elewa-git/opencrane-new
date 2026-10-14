import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { requireBridgeGateAuthority } from './bridge-gate-authority.ts';

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/u.test(value)) {
    throw new Error('Invalid gate reference');
  }
  return value;
}

function request(value: Record<string, unknown>) {
  const allowed = new Set(['type', 'takeoverId', 'generation', 'affectedTurnIds']);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error('Invalid gate field');
  }
  const takeoverId = identifier(value['takeoverId']);
  const generation = value['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Invalid gate generation');
  }
  const turns = value['affectedTurnIds'];
  if (!Array.isArray(turns) || turns.length > 64) throw new Error('Invalid gate turns');
  const affectedTurnIds = turns.map(identifier);
  affectedTurnIds.sort();
  if (new Set(affectedTurnIds).size !== affectedTurnIds.length) {
    throw new Error('Repeated gate turn');
  }
  return { takeoverId, generation, affectedTurnIds };
}

export class BridgeGate {
  private binding: ReturnType<typeof request> | undefined;
  private readonly epoch = randomUUID();
  readonly interrupted = new Set<string>();
  readonly awaitingTerminal = new Set<string>();
  pending = 0;
  failed = false;

  get closed() { return this.binding !== undefined; }

  close(value: Record<string, unknown>) {
    requireBridgeGateAuthority();
    const next = request(value);
    if (this.binding && JSON.stringify(this.binding) !== JSON.stringify(next)) {
      throw new Error('Different bridge gate');
    }
    this.binding = next;
  }

  async track(work: Promise<void>) {
    this.pending++;
    try {
      await work;
    } catch {
      // Keep failed cleanup separate from a normal terminal turn report.
      this.failed = true;
    } finally {
      this.pending--;
    }
  }

  async receipt(check: () => Promise<boolean>) {
    const deadline = performance.now() + 30_000;
    const unavailable = { type: 'bridge_unavailable', ...this.binding, epoch: this.epoch };
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    function expired(resolve: (value: typeof unavailable) => void) {
      timer = setTimeout(resolve, 30_000, unavailable);
    }
    async function inspect() {
      while (!finished && performance.now() < deadline) {
        if (await check()) return true;
        await delay(20);
      }
      return false;
    }
    const timeout = new Promise(expired);
    try {
      const quiet = await Promise.race([inspect(), timeout]);
      if (quiet !== true || performance.now() >= deadline) return unavailable;
      const interruptedTurnIds = [...this.interrupted];
      interruptedTurnIds.sort();
      return { type: 'bridge_quiet', ...this.binding, epoch: this.epoch,
        interruptedTurnIds, preparingTurnIds: [], runningTurnIds: [],
        loadedThreadIds: [], heldApprovalIds: [], executorProof: 'unavailable',
        browserProof: 'unavailable' };
    } catch {
      return unavailable;
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  }
}
