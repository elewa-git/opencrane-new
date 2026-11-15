import { appendFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { natsFixture, event } from '@opencrane/event-store/testing';
import type { EventStore } from '@opencrane/event-store';
import { postgresFixture } from '../src/postgres-fixture.ts';
import type { PostgresEventStore } from '../src/postgres-event-store.ts';

type Store = EventStore | PostgresEventStore;

async function measurePressure(store: Store, backend: string) {
  const permission = event('permission', 'member-authority');
  expect(await store.append({ event: permission, expectedSequence: 0 })).toMatchObject({
    status: 'appended' });
  const authorityPosition = await store.head(permission.subject);
  let stopped = false;
  let activeWriters = 0;
  let backgroundAppended = 0;
  let backgroundRefused = 0;
  async function writeUnrelated(writer: number) {
    activeWriters += 1;
    let iteration = 0;
    try {
      while (!stopped) {
        const id = `noise-${writer}-${iteration}`;
        const command = { event: event(id, `member-${id}`), expectedSequence: 0,
          historyChecked: true as const };
        const result = await store.append(command);
        if (result.status === 'appended') backgroundAppended += 1;
        else backgroundRefused += 1;
        iteration += 1;
      }
    } finally {
      activeWriters -= 1;
    }
  }
  const writers: Promise<void>[] = [];
  for (let index = 0; index < 50; index += 1) writers.push(writeUnrelated(index));
  const outcomes = { appended: 0, conflict: 0, unavailable: 0, rejected: 0 };
  let overlapping = 0;
  async function checkAccess() {
    const position = await store.head(permission.subject);
    expect(position).toBe(authorityPosition);
  }
  try {
    for (let probe = 0; probe < 100; probe += 1) {
      if (activeWriters === 50) overlapping += 1;
      const id = `valid-${probe}`;
      const command = { event: event(id, `member-${id}`), expectedSequence: 0,
        historyChecked: true as const, deadline: performance.now() + 2000,
        checkAccess, accessSubjects: [permission.subject] };
      const result = await store.append(command);
      outcomes[result.status] += 1;
      const saved = await store.head(command.event.subject);
      expect(saved > 0).toBe(result.status === 'appended');
    }
  } finally {
    stopped = true;
    await Promise.all(writers);
  }
  expect(await store.head(permission.subject)).toBe(authorityPosition);
  const result = { backend, writers: 50, probes: 100, overlapping, outcomes,
    backgroundAppended, backgroundRefused };
  await appendFile('spikes/s0-9-postgres-event-store/results/pressure.jsonl',
    `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify(result));
}

async function comparePressure() {
  const connectionString = process.env['SPIKE_PG_URL'];
  if (!connectionString) throw new Error('Set SPIKE_PG_URL to the private measurement container');
  const nats = await natsFixture();
  try {
    await measurePressure(nats.store, 'jetstream');
  } finally {
    await nats.close();
  }
  const postgres = await postgresFixture(connectionString);
  try {
    await measurePressure(postgres.store, 'postgres');
  } finally {
    await postgres.close();
  }
}
it('counts valid writes refused during fifty unrelated writer loops', comparePressure, 300_000);
