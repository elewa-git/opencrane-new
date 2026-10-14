import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { requireBridgeGateAuthority, type GateBinding, type GateIdentity } from './bridge-gate-authority.ts';

export class BridgeGate {
  private binding: GateBinding | undefined;
  private readonly epoch = randomUUID();
  readonly interrupted = new Set<string>();
  readonly awaitingTerminal = new Set<string>();
  pending = 0;
  failed = false;

  get closed() { return this.binding !== undefined; }

  close(value: Record<string, unknown>, identity: GateIdentity | undefined) {
    if (Object.keys(value).length !== 2 || value['type'] !== 'bridge_gate') {
      throw new Error('Invalid bridge gate');
    }
    // Check the saved computer identity before any stop or cleanup can begin.
    const next = requireBridgeGateAuthority(value['gate'], identity);
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
