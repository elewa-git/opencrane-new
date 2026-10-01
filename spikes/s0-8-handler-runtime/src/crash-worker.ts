// A standalone pg-boss worker process for the crash-recovery tests. The test
// spawns this as a REAL separate OS process and SIGKILLs it mid-handler, so
// "the worker crashes" is a genuine process death with no chance to clean up.
//
//   node --experimental-strip-types src/crash-worker.ts \
//     <connectionString> <queue> <mode> <effectsTable> <sleepBeforeEffectMs> <holdAfterEffectMs>
//
// Modes:
//   guarded      write the effect with an idempotency key (skip it if already recorded)
//   unguarded    write the effect with no idempotency key (the control case)
//   transactional run the handler inside pg-boss's own transaction: the effect
//                and the job's completion commit together or not at all
import { PgBoss } from 'pg-boss';
import pg from 'pg';

const [, , connectionStringArg, queueArg, modeArg, effectsTableArg, sleepBeforeArg, holdAfterArg] = process.argv;
if (!connectionStringArg || !queueArg || !modeArg || !effectsTableArg) {
  throw new Error('usage: crash-worker <connectionString> <queue> <mode> <effectsTable> <sleepBefore> <holdAfter>');
}
const connectionString: string = connectionStringArg;
const queue: string = queueArg;
const mode: string = modeArg;
const effectsTable: string = effectsTableArg;
const sleepBeforeEffectMs = Number(sleepBeforeArg ?? '1000');
const holdAfterEffectMs = Number(holdAfterArg ?? '0');

interface JobData {
  idempotencyKey: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString });
  boss.on('error', (err) => console.error('WORKER boss error', err));
  await boss.start();

  if (mode === 'transactional') {
    await boss.work(
      queue,
      { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5, transactional: true },
      async (jobs, tx) => {
        const job = jobs[0];
        if (!job) return;
        const { idempotencyKey } = job.data as JobData;
        console.log(`WORKER started ${idempotencyKey}`);
        await sleep(sleepBeforeEffectMs);
        // The effect is written through pg-boss's own transaction. If this
        // process dies before the handler returns, the whole transaction
        // (this write and the job's completion) rolls back.
        await tx.executeSql(`INSERT INTO ${effectsTable} (idempotency_key, applied_at) VALUES ($1, now())`, [
          idempotencyKey,
        ]);
        console.log(`WORKER effect-applied ${idempotencyKey}`);
        await sleep(holdAfterEffectMs);
      },
    );
  } else {
    await boss.work<JobData>(
      queue,
      { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        const job = jobs[0];
        if (!job) return;
        const { idempotencyKey } = job.data;
        const db = new pg.Client({ connectionString });
        await db.connect();
        try {
          if (mode === 'guarded') {
            const seen = await db.query(`SELECT 1 FROM ${effectsTable} WHERE idempotency_key = $1`, [idempotencyKey]);
            if ((seen.rowCount ?? 0) > 0) {
              console.log(`WORKER already-applied ${idempotencyKey}`);
              return;
            }
          }
          console.log(`WORKER started ${idempotencyKey}`);
          await sleep(sleepBeforeEffectMs);
          await db.query(
            `INSERT INTO ${effectsTable} (idempotency_key, applied_at) VALUES ($1, now())
             ${mode === 'guarded' ? 'ON CONFLICT (idempotency_key) DO NOTHING' : ''}`,
            [idempotencyKey],
          );
          console.log(`WORKER effect-applied ${idempotencyKey}`);
          // The crash window the guarded case is about: the effect is
          // already written but the job has not been marked complete yet.
          await sleep(holdAfterEffectMs);
        } finally {
          await db.end();
        }
      },
    );
  }

  console.log('WORKER ready');
}

main().catch((err: unknown) => {
  console.error('WORKER fatal', err);
  process.exit(1);
});
