import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import { memoryMaintenanceRecordedDataSchema } from '@opencrane/events';
import { memoryWrittenExample } from '../../../libs/events/src/memory.ts';
import { memoryProjection, memoryScopeId, ProjectionRunner } from '@opencrane/projections';
import { fixture, logger } from '../../../libs/handlers/test/helpers.ts';
import { scanNightlyMemory } from '../src/nightly-memory.ts';

let services: Awaited<ReturnType<typeof fixture>>;
const scopeId = memoryScopeId('test', 'person', 'alice');
const projection = memoryProjection({ decrypt });
function decrypt() { return null; }
afterEach(async function close() { await services?.close(); });
async function append(type: string, data: unknown, time = '2026-10-12T01:00:00Z') {
  const id = `${type.replaceAll('.', '-')}-${await services.nats.store.head()}`;
  const record = { ...event(id, `scope-${scopeId}`, type), silo: 'test', source: 'opencrane-server', time, data,
    commandId: id, principal: { kind: 'human' as const, id: 'alice' } };
  const command = { event: record,
    expectedSequence: await services.nats.store.head(record.subject), historyChecked: true as const };
  expect((await services.nats.store.append(command)).status).toBe('appended');
}
function written(memoryId = memoryWrittenExample.memoryId) {
  const fields = ['test', scopeId, 'person', 'alice', memoryId, 1];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(fields));
  return { ...memoryWrittenExample, scopeId, memoryId, keyId: `key:${hash.digest('hex')}` };
}
async function setup(dirty = true) {
  services = await fixture();
  const binding = { scopeId, scopeKind: 'person', ownerId: 'alice', memberId: 'alice',
    assistantId: 'assistant', payingGroupId: 'sales', enabled: true,
    acceptedCapCents: 100, revision: 1 };
  await append('memory.maintenance_bound', binding);
  if (dirty) {
    await append('memory.written', written());
  }
  const runner = new ProjectionRunner(services.db, services.nats.reader, logger);
  await runner.initialise(projection);
  await runner.run(projection);
}
async function records() {
  const rows = [];
  for await (const row of services.nats.store.readStream(`scope-${scopeId}`)) {
    if (row.event.type === 'memory.maintenance_recorded') rows.push(row.event.data);
  }
  return rows;
}
async function scan(time: string) {
  const runner = new ProjectionRunner(services.db, services.nats.reader, logger);
  await runner.run(projection);
  await scanNightlyMemory(services.db, services.nats.store, 'test', new Date(time));
}
it('crosses the boundary once, keeps dirty inputs and ignores duplicate or changed delivery',
  async function boundary() {
    await setup();
    await scan('2026-10-12T01:59:59Z');
    expect(await records()).toEqual([]);
    await Promise.all([scan('2026-10-12T02:00:00Z'), scan('2026-10-12T02:00:00Z')]);
    const first = await records();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ action: 'refused', reason: 'qualification_blocked',
      intendedAt: '2026-10-12T02:00:00.000Z', acceptedCapCents: 100 });
    await append('memory.written', written('later'));
    await scan('2026-10-12T02:01:00Z');
    expect(await records()).toEqual(first);
    await scan('2026-10-13T02:00:00Z');
    expect(await records()).toHaveLength(2);
  }, 30_000);
it('leaves a clean scope alone', async function clean() {
  await setup(false);
  await scan('2026-10-12T02:00:00Z');
  expect(await records()).toEqual([]);
}, 30_000);
it('records late and offline nights without catching up older nights', async function missed() {
  await setup();
  await scan('2026-10-12T02:15:00Z');
  await scan('2026-10-15T11:00:00Z');
  expect(await records()).toHaveLength(2);
  expect(await records()).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'missed', reason: 'window_missed',
      intendedAt: '2026-10-15T02:00:00.000Z' }),
  ]));
  await scan('2026-10-16T02:00:00Z');
  expect(await records()).toHaveLength(3);
}, 30_000);
it('records overlap and retains the dirty backlog', async function overlap() {
  await setup();
  await scan('2026-10-12T02:00:00Z');
  const [first] = await records();
  await append('memory.maintenance_recorded', { ...memoryMaintenanceRecordedDataSchema.parse(first),
    action: 'due', reason: null }, '2026-10-12T02:01:00Z');
  await scan('2026-10-13T02:00:00Z');
  expect(await records()).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'missed', reason: 'overlap' }),
  ]));
}, 30_000);

it('two scheduler processes claim the same scope, date and input key once',
  async function processes() {
    await setup();
    const children = [];
    const ready = [];
    const exited = [];
    for (let index = 0; index < 2; index++) {
      const env = { ...process.env, ...services.nats.env(),
        NIGHTLY_TEST_DATABASE: services.connectionString };
      const child = fork('apps/ops/test/support/nightly-process.ts', [],
        { env, execArgv: ['--experimental-strip-types'] });
      children.push(child);
      ready.push(once(child, 'message'));
      exited.push(once(child, 'exit'));
    }
    try {
      await Promise.all(ready);
      for (const child of children) child.send('go');
      const results = await Promise.all(exited);
      expect(results).toEqual([[0, null], [0, null]]);
      expect(await records()).toHaveLength(1);
      await scan('2026-10-12T02:01:00Z');
      expect(await records()).toHaveLength(1);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  }, 30_000);
