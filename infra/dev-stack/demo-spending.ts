import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { EventStore } from '@opencrane/event-store';
import type { BrowserContext, Request } from 'playwright';
import { demoBudget } from './demo-prepare.ts';

type Options = Parameters<typeof demoBudget>[0];
type Store = Pick<EventStore, 'head' | 'readStream'>;
type Call = { reservationId: string; turnId: string; chargedCents: number | null; heldCents: number };

export async function demoSpending(options: Options, output: string, sha: string,
  store: Store, silo: string, contexts: BrowserContext[]) {
  const budget = await demoBudget(options);
  const position = await store.head(`budget-${silo}`, performance.now() + 10_000);
  const starting = { position, budget };
  const turns = new Set<string>();
  const calls = new Map<string, Call>();
  function submitted(request: Request) {
    const url = new URL(request.url());
    if (request.method() !== 'POST' || url.origin !== options.origin ||
        !/^\/api\/conversations\/[^/]+\/messages$/u.test(url.pathname)) return;
    const body = request.postDataJSON() as { id?: unknown };
    if (typeof body.id !== 'string') return;
    turns.add(body.id);
    // Keep only ids, never prompts or credentials, even if the process stops mid-turn.
    writeFileSync(`${output}/turns.json`, JSON.stringify([...turns]), { mode: 0o600, flush: true });
  }
  function stop() {
    for (const context of contexts) context.off('request', submitted);
  }
  async function save() {
    let status = 'RECORDED';
    let currentBudget;
    try {
      const deadline = performance.now() + 10_000;
      for await (const row of store.readStream(`budget-${silo}`, position + 1, deadline)) {
        if (row.sequence <= position) continue;
        const data = row.event.data as Record<string, unknown>;
        const reservationId = data['reservationId'] as string;
        if (row.event.type === 'budget.reserved') {
          const modelCall = data['modelCall'] as { turnId: string } | undefined;
          if (!modelCall || !turns.has(modelCall.turnId)) continue;
          calls.set(reservationId, { reservationId, turnId: modelCall.turnId,
            chargedCents: null, heldCents: data['amountCents'] as number });
        }
        if (row.event.type === 'budget.settled' && data['outcome'] !== 'unknown') {
          const call = calls.get(reservationId);
          if (call) {
            call.chargedCents = data['settledCents'] as number;
            call.heldCents = 0;
          }
        }
      }
      currentBudget = await demoBudget(options);
    } catch {
      // Keep the last known charges and holds when final observation is unavailable.
      status = 'PARTIAL';
    }
    let chargedCents = 0;
    let heldCents = 0;
    for (const call of calls.values()) {
      chargedCents += call.chargedCents ?? 0;
      heldCents += call.heldCents;
    }
    const receipt = { sha, status, starting, turnIds: [...turns], callCount: calls.size,
      calls: [...calls.values()], chargedCents, heldCents, budget: currentBudget ?? null };
    await writeFile(`${output}/spending.json`, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  }
  await save();
  for (const context of contexts) context.on('request', submitted);
  return { save, stop };
}
