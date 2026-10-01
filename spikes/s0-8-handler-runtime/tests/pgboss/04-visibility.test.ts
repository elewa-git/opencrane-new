import { stopChild } from '../../src/process-stop.ts';
// Pass condition 4: per-handler visibility. Can you see, per handler, the
// runs, attempts, errors and logs, with no screenshots?
//
// events.md names every reaction as its own handler with its own queue
// (settle-budget, wake-computer, update-openfga). One event fans out to one
// job per handler. This test runs such a fan-out, makes one handler flaky and
// one permanently failing, and reads everything back three ways: SQL (the
// "event timeline" view), the pg-boss API, and the first-party web dashboard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, startStaggeredWorkers, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { sql } from '../../src/pgboss-query.ts';
import { waitUntil } from '../../src/util.ts';

const DASHBOARD_CLI = join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@pg-boss/dashboard/bin/cli.js');

interface FanOutData {
  eventId: string;
  eventType: string;
  stream: string;
}

describe('pg-boss: per-handler visibility without a screenshot', () => {
  let tpg: TestPg;
  let t: TestBoss;
  let dashboard: ChildProcess | undefined;
  const logs: { handler: string; eventId: string; attempt: number; outcome: string; error?: string }[] = [];

  beforeAll(async () => {
    tpg = await startPg('visibility');
    t = await startBoss(tpg.connectionString);
  }, 90_000);

  afterAll(async () => {
    if (dashboard) await stopChild(dashboard);
    await stopBoss(t);
    await tpg?.stop();
  });

  it('shows runs, attempts, errors and logs for each handler of one event', async () => {
    await t.boss.createQueue('settle-budget', { retryLimit: 0 });
    await t.boss.createQueue('wake-computer', { retryLimit: 5, retryDelay: 0 });
    await t.boss.createQueue('update-openfga', { retryLimit: 1, retryDelay: 0 });

    const attemptsSeen = new Map<string, number>();
    const runHandler = (handler: string, behave: (attempt: number) => void) => async (job: { data: FanOutData }) => {
      const attempt = (attemptsSeen.get(handler) ?? 0) + 1;
      attemptsSeen.set(handler, attempt);
      try {
        behave(attempt);
        logs.push({ handler, eventId: job.data.eventId, attempt, outcome: 'ok' });
      } catch (err) {
        // The structured log line a real handler would write (pino JSON).
        logs.push({ handler, eventId: job.data.eventId, attempt, outcome: 'error', error: (err as Error).message });
        throw err;
      }
    };
    await startStaggeredWorkers<FanOutData>(t.boss, 'settle-budget', 2, { pollingIntervalSeconds: 0.5 }, runHandler('settle-budget', () => undefined));
    await startStaggeredWorkers<FanOutData>(
      t.boss,
      'wake-computer',
      2,
      { pollingIntervalSeconds: 0.5 },
      runHandler('wake-computer', (attempt) => {
        if (attempt <= 2) throw new Error(`computer not ready (attempt ${attempt})`);
      }),
    );
    await startStaggeredWorkers<FanOutData>(
      t.boss,
      'update-openfga',
      2,
      { pollingIntervalSeconds: 0.5 },
      runHandler('update-openfga', (attempt) => {
        throw new Error(`openfga returned 503 (attempt ${attempt})`);
      }),
    );

    // One event, fanned out to its three handlers.
    const event: FanOutData = { eventId: 'evt-0001', eventType: 'effect.observed', stream: 'budget-acme' };
    for (const handler of ['settle-budget', 'wake-computer', 'update-openfga']) {
      await t.boss.send(handler, event, { singletonKey: event.stream });
    }

    const timelineSql = `
      SELECT name AS handler, state, retry_count AS "retryCount", output, id,
             created_on AS "createdOn", started_on AS "startedOn", completed_on AS "completedOn"
      FROM pgboss.job
      WHERE data->>'eventId' = $1
      ORDER BY name`;
    type TimelineRow = {
      handler: string;
      state: string;
      retryCount: number;
      output: { message?: string } | null;
      id: string;
      createdOn: Date;
      startedOn: Date | null;
      completedOn: Date | null;
    };
    await waitUntil(async () => {
      const rows = await sql<TimelineRow>(tpg.connectionString, timelineSql, [event.eventId]);
      return rows.length === 3 && rows.every((r) => r.state === 'completed' || r.state === 'failed');
    }, 30_000, 150);
    for (const h of ['settle-budget', 'wake-computer', 'update-openfga']) await t.boss.offWork(h);

    // ---- 1. SQL: the "event timeline" for one event --------------------------
    const timeline = await sql<TimelineRow>(tpg.connectionString, timelineSql, [event.eventId]);
    console.log(
      '[visibility] event timeline: ' +
        timeline.map((r) => `${r.handler}=${r.state}/retries=${r.retryCount}`).join(' | '),
    );
    const byHandler = new Map(timeline.map((r) => [r.handler, r]));
    expect(byHandler.get('settle-budget')).toMatchObject({ state: 'completed', retryCount: 0 });
    expect(byHandler.get('wake-computer')).toMatchObject({ state: 'completed', retryCount: 2 });
    expect(byHandler.get('update-openfga')).toMatchObject({ state: 'failed', retryCount: 1 });
    // The last error is stored on the job itself.
    expect(byHandler.get('update-openfga')?.output?.message).toContain('openfga returned 503');
    // Timestamps give run time and queue delay per handler.
    for (const row of timeline) {
      expect(row.startedOn).not.toBeNull();
      expect(row.completedOn).not.toBeNull();
    }

    // ---- 2. Honest limits ----------------------------------------------------
    // pg-boss keeps the attempt COUNT and only the LAST error. The earlier
    // failures of the flaky handler are gone from the job row once it succeeds,
    // so per-attempt history has to come from the handler's own logs.
    expect(JSON.stringify(byHandler.get('wake-computer')?.output ?? null)).not.toContain('attempt 1');
    const wakeLogs = logs.filter((l) => l.handler === 'wake-computer');
    expect(wakeLogs.map((l) => `${l.attempt}:${l.outcome}`)).toEqual(['1:error', '2:error', '3:ok']);
    expect(wakeLogs[0]?.error).toBe('computer not ready (attempt 1)');
    console.log(`[visibility] application logs (volatile): ${JSON.stringify(logs)}`);

    // ---- 3. API: per-queue counts and held streams --------------------------
    await t.boss.supervise(); // refresh the queue counters now instead of waiting for the monitor
    const openfga = await t.boss.getQueue('update-openfga');
    console.log(`[visibility] getQueue('update-openfga'): failed=${openfga?.failedCount} total=${openfga?.totalCount}`);
    expect(openfga?.failedCount).toBe(1);
    const found = await t.boss.findJobs<FanOutData>('wake-computer', { data: { eventId: event.eventId } });
    expect(found).toHaveLength(1);
    expect(found[0]?.retryCount).toBe(2);

    // ---- 4. Web dashboard (first-party, MIT) --------------------------------
    const port = 24000 + Math.floor(Math.random() * 4000);
    const dash = spawn(process.execPath, [DASHBOARD_CLI], {
      env: { ...process.env, DATABASE_URL: tpg.connectionString, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dashboard = dash;
    await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/queues`)).ok;
      } catch {
        return false;
      }
    }, 30_000, 250);
    const text = async (path: string) => {
      const html = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
      return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    };
    const queuesPage = await text('/queues');
    for (const h of ['settle-budget', 'wake-computer', 'update-openfga']) expect(queuesPage).toContain(h);
    const failedJobId = byHandler.get('update-openfga')!.id;
    const jobPage = await text(`/queues/update-openfga/jobs/${failedJobId}`);
    console.log(`[visibility] dashboard job page excerpt: ${jobPage.slice(jobPage.indexOf('update-openfga'), jobPage.indexOf('update-openfga') + 300)}`);
    expect(jobPage.toLowerCase()).toContain('failed');
    expect(jobPage).toContain('openfga returned 503');
    expect(t.errors).toEqual([]);
  }, 120_000);
});
