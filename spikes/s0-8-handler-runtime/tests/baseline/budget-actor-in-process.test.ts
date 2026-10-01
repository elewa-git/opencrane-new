// Baseline for pass condition 5: the budget actor as plan.md describes it,
// with NO handler runtime at all. One leader-elected process keeps a queue per
// budget key in memory and answers one request at a time. Leadership is a
// PostgreSQL advisory lock, so a second process cannot also lead.
//
// This is not a candidate. It shows what the runtime-free design costs, so the
// ADR can say whether the actor needs pg-boss or Temporal at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newPool, startPg, type TestPg } from '../../src/pg.ts';
import {
  applyBudgetRequest,
  createBudget,
  createBudgetTables,
  readBudget,
  type BudgetAnswer,
  type BudgetRequest,
} from '../../src/budget-store.ts';
import { percentile } from '../../src/util.ts';

const LOCK_ID = 80808; // an arbitrary advisory-lock number for "the budget actor of this silo"

class InProcessBudgetActor {
  private readonly tails = new Map<string, Promise<unknown>>();
  private leaderConnection: pg.Client | undefined;
  constructor(
    private readonly pool: pg.Pool,
    private readonly connectionString: string,
    private readonly serialise: boolean,
  ) {}

  /** Try to become the leader. Returns false if another process already is. */
  async tryLead(): Promise<boolean> {
    const c = new pg.Client({ connectionString: this.connectionString });
    await c.connect();
    const { rows } = await c.query<{ got: boolean }>(`SELECT pg_try_advisory_lock($1) AS got`, [LOCK_ID]);
    if (!rows[0]!.got) {
      await c.end();
      return false;
    }
    this.leaderConnection = c;
    return true;
  }

  async resign(): Promise<void> {
    await this.leaderConnection?.end();
    this.leaderConnection = undefined;
  }

  request(req: Omit<BudgetRequest, 'requestId'>, gapMs = 1): Promise<BudgetAnswer> {
    const full: BudgetRequest = { ...req, requestId: randomUUID() };
    if (!this.serialise) return applyBudgetRequest(this.pool, full, gapMs);
    // One request at a time per key: chain onto that key's previous request.
    const previous = this.tails.get(req.key) ?? Promise.resolve();
    const next = previous.then(() => applyBudgetRequest(this.pool, full, gapMs));
    this.tails.set(req.key, next.catch(() => undefined));
    return next;
  }
}

describe('baseline: in-process single-writer budget actor (no handler runtime)', () => {
  let tpg: TestPg;
  let pool: pg.Pool;

  beforeAll(async () => {
    tpg = await startPg('budget-inproc');
    pool = newPool(tpg.connectionString, 30);
    await createBudgetTables(pool);
  }, 90_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await tpg?.stop();
  });

  it('answers 1,000 sequential and 100 concurrent reserves with no overspend, and only one process can lead', async () => {
    const actor = new InProcessBudgetActor(pool, tpg.connectionString, true);
    expect(await actor.tryLead()).toBe(true);
    const rival = new InProcessBudgetActor(pool, tpg.connectionString, true);
    expect(await rival.tryLead(), 'a second process must not be able to lead at the same time').toBe(false);

    await createBudget(pool, 'seq', 1_000_000);
    const seq: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      const a = await actor.request({ op: 'reserve', key: 'seq', amountCents: 1 });
      seq.push(performance.now() - t0);
      expect(a.accepted).toBe(true);
    }
    expect((await readBudget(pool, 'seq')).reservedCents).toBe(1000);

    await createBudget(pool, 'conc', 500);
    const t1 = performance.now();
    const lat: number[] = [];
    const answers = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const s = performance.now();
        const a = await actor.request({ op: 'reserve', key: 'conc', amountCents: 10 });
        lat.push(performance.now() - s);
        return a;
      }),
    );
    const wall = performance.now() - t1;
    console.log(
      `[budget-actor:in-process] 1000 sequential: p50=${percentile(seq, 50).toFixed(1)}ms p99=${percentile(seq, 99).toFixed(1)}ms | ` +
        `100 concurrent on one key: wall=${wall.toFixed(0)}ms p50=${percentile(lat, 50).toFixed(0)}ms p99=${percentile(lat, 99).toFixed(0)}ms`,
    );
    const state = await readBudget(pool, 'conc');
    expect(answers.filter((a) => a.accepted)).toHaveLength(50);
    expect(state).toMatchObject({ reservedCents: 500, ceilingCents: 500, logged: 50 });

    // Failover: when the leader goes away, another process can take over.
    await actor.resign();
    await new Promise((r) => setTimeout(r, 200));
    expect(await rival.tryLead(), 'a second process can lead once the first has gone').toBe(true);
    await rival.resign();
  }, 120_000);

  it('NEGATIVE CONTROL: without the in-process queue the same handler overspends', async () => {
    const unsafe = new InProcessBudgetActor(pool, tpg.connectionString, false);
    await createBudget(pool, 'control', 500);
    const answers = await Promise.all(Array.from({ length: 100 }, () => unsafe.request({ op: 'reserve', key: 'control', amountCents: 10 }, 5)));
    const accepted = answers.filter((a) => a.accepted).length;
    const state = await readBudget(pool, 'control');
    console.log(`[budget-actor:in-process-control] unserialised: accepted=${accepted} (limit 50), balance=${state.reservedCents}`);
    expect(accepted, 'unserialised writers must accept more than fit').toBeGreaterThan(60);
  }, 60_000);
});
