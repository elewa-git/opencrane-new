// A stand-in for the per-silo `workers` Deployment: one Node process that
// embeds pg-boss and runs a handler on each of several named queues
// (the handler names come from docs/architecture/events.md).
//
//   node --experimental-strip-types src/pgboss-app.ts <connectionString> <workersPerQueue>
import { PgBoss } from 'pg-boss';

const [, , connectionStringArg, workersArg] = process.argv;
if (!connectionStringArg) throw new Error('usage: pgboss-app <connectionString> <workersPerQueue>');
const connectionString: string = connectionStringArg;
const workersPerQueue = Number(workersArg ?? '2');

export const HANDLER_QUEUES = [
  'settle-budget',
  'wake-computer',
  'update-openfga',
  'deliver-message',
  'notify-admin',
  'regenerate-gateway-config',
  'schedule-routine',
  'revoke-credential',
  'queue-dreaming',
  'audit-write',
];

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString });
  boss.on('error', (err) => console.error('APP boss error', err));
  await boss.start();
  let handled = 0;
  for (const queue of HANDLER_QUEUES) {
    await boss.createQueue(queue, { policy: 'key_strict_fifo', retryLimit: 2 });
    for (let i = 0; i < workersPerQueue; i++) {
      await boss.work(queue, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 0.5, burstWhenReadyExceeds: 1 }, async () => {
        handled++;
      });
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  console.log('APP ready');
  setInterval(() => console.log(`APP handled ${handled}`), 1000).unref();
}

main().catch((err: unknown) => {
  console.error('APP fatal', err);
  process.exit(1);
});
