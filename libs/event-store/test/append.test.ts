import { TimeoutError } from '@nats-io/transport-node';
import { EventStore, type AppendCommand } from '../src/index.ts';
import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { event, natsFixture } from "./testing.ts";

let fixture: Awaited<ReturnType<typeof natsFixture>>;
afterEach(async () => {
  await fixture?.close();
});

it("accepts the EVENTS configuration and supports two projection consumers", async () => {
  fixture = await natsFixture();
  await fixture.store.ensureStream({ replicas: 1 });
  const manager = await jetstreamManager(fixture.connection);
  const info = await manager.streams.info("EVENTS");
  expect(info.config).toMatchObject({
    num_replicas: 1,
    max_age: 0,
    max_msgs: -1,
    max_consumers: -1,
    max_msg_size: -1,
    duplicate_window: 120_000_000_000,
    discard: "old",
    storage: "file",
  });
  expect(
    await fixture.store.append({ event: event("accepted"), expectedSequence: 0 }),
  ).toEqual({ status: "appended", sequence: 1 });
  const consumers = [fixture.store.subscribe(), fixture.store.subscribe()];
  try {
    const results = await Promise.all(consumers.map((consumer) => consumer.next()));
    for (const result of results) {
      expect(result.done).toBe(false);
      if (!result.done) {
        expect(result.value.sequence).toBe(1);
      }
    }
  } finally {
    await Promise.all(consumers.map((consumer) => consumer.return(undefined)));
  }
});

it.each([
  ["max_msgs", { max_msgs: 10 }],
  ["max_consumers", { max_consumers: 1 }],
  ["max_msg_size", { max_msg_size: 16 }],
  ["republish", { republish: { src: "ev.>", dest: "copy.>" } }],
  ["no_ack", { no_ack: true }],
  ["duplicate_window", { duplicate_window: 1_000_000_000 }],
  ["consumer_limits", { consumer_limits: { max_ack_pending: 1 } }],
])("rejects incompatible %s without repairing it", async (field, change) => {
  fixture = await natsFixture();
  const manager = await jetstreamManager(fixture.connection);
  const { config } = await manager.streams.info("EVENTS");
  // max_consumers cannot be updated, so create a pre-existing incompatible stream.
  await manager.streams.delete("EVENTS");
  // NATS removes the old stream's files in the background, so creating it again
  // straight away can fail with "error creating store". Retry for a short while.
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      await manager.streams.add({ ...config, ...change });
      break;
    } catch (error) {
      const storeNotReady =
        error instanceof JetStreamApiError &&
        error.code === 10049 &&
        error.message === "error creating store for stream";
      if (!storeNotReady || performance.now() >= deadline) {
        throw error;
      }
      await delay(50);
    }
  }
  await expect(fixture.store.ensureStream({ replicas: 1 })).rejects.toThrow(field);
  expect((await manager.streams.info("EVENTS")).config).toMatchObject(change);
});

it("accepts settings that only affect operations or read access", async () => {
  fixture = await natsFixture();
  const manager = await jetstreamManager(fixture.connection);
  await manager.streams.update("EVENTS", {
    description: "Silo events",
    metadata: { owner: "test" },
    compression: "s2",
    allow_direct: true,
  });
  await expect(fixture.store.ensureStream({ replicas: 1 })).resolves.toBeUndefined();
});

it("rejects malformed events without writing; races have exactly one winner", async () => {
  fixture = await natsFixture();
  for (const invalid of [
    {},
    { ...event("bad"), commandId: "" },
    { ...event("bad"), subject: "member-a.*" },
    { ...event("bad"), subject: "member-*" },
    { ...event("bad"), principal: undefined },
    { ...event("bad"), data: {} },
  ]) {
    expect(
      await fixture.store.append({ event: invalid, expectedSequence: 0 }),
    ).toEqual({ status: "rejected", reason: "invalid_event" });
  }
  expect(await fixture.store.head()).toBe(0);
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, n) =>
      fixture.store.append({ event: event(`race-${n}`), expectedSequence: 0 }),
    ),
  );
  expect(results.filter((result) => result.status === "appended")).toEqual([
    { status: "appended", sequence: 1 },
  ]);
  expect(results.filter((result) => result.status === "conflict")).toHaveLength(
    15,
  );
  expect(
    await Array.fromAsync(fixture.store.readStream("member-alice")),
  ).toHaveLength(1);
});

it("recognises concurrent and old commands by principal and subject, not event id", async () => {
  fixture = await natsFixture();
  const command = event("first");
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      fixture.store.append({
        event: { ...command, id: `attempt-${n}` },
        expectedSequence: 0,
      }),
    ),
  );
  expect(results).toEqual(
    Array.from({ length: 8 }, () => ({ status: "appended", sequence: 1 })),
  );
  expect(
    await fixture.store.append({ event: event("second"), expectedSequence: 1 }),
  ).toEqual({ status: "appended", sequence: 2 });
  expect(
    await fixture.store.append({
      event: { ...command, id: "fresh-id" },
      expectedSequence: 2,
    }),
  ).toEqual({ status: "appended", sequence: 1 });
  expect(
    await fixture.store.append({
      event: {
        ...command,
        id: "other-principal",
        principal: { id: "other", kind: "human" },
      },
      expectedSequence: 2,
    }),
  ).toEqual({ status: "appended", sequence: 3 });
  expect(
    await fixture.store.append({
      event: { ...command, id: "other-subject", subject: "member-bob" },
      expectedSequence: 0,
    }),
  ).toEqual({ status: "appended", sequence: 4 });
  expect(await fixture.store.head()).toBe(4);
  expect(
    (await Array.fromAsync(fixture.store.readStream("member-alice", 2))).map(
      (stored) => stored.sequence,
    ),
  ).toEqual([2, 3]);
});

it("reads a category across entities in global order without unrelated events", async () => {
  fixture = await natsFixture();
  for (const [id, subject, type] of [
    ["category-a", "member-alice", "member.joined"],
    ["category-b", "budget-first", "budget.ceiling_set"],
    ["category-c", "member-bob", "member.joined"],
    ["category-d", "budget-second", "budget.ceiling_set"],
  ] as const) {
    const input = type === "budget.ceiling_set"
      ? { ...event(id, subject, type), data: { scope: "global", ceilingCents: 20000, setBy: "admin" } }
      : event(id, subject, type);
    expect(
      await fixture.store.append({ event: input, expectedSequence: 0 }),
    ).toMatchObject({ status: "appended" });
  }
  expect(
    (await Array.fromAsync(fixture.store.readStream("member-*"))).map(row => row.sequence),
  ).toEqual([1, 3]);
  expect(
    (await Array.fromAsync(fixture.store.readStream("member-*", 2))).map(row => row.event.subject),
  ).toEqual(["member-bob"]);
  expect(await Array.fromAsync(fixture.store.readStream("assistant-*"))).toEqual([]);
});

it("refuses a stream-wide duplicate acknowledgement for another subject or command", async () => {
  fixture = await natsFixture();
  expect(
    await fixture.store.append({
      event: event("collision"),
      expectedSequence: 0,
    }),
  ).toEqual({ status: "appended", sequence: 1 });
  expect(
    await fixture.store.append({
      event: event("collision", "member-bob"),
      expectedSequence: 0,
    }),
  ).toEqual({ status: "rejected", reason: "duplicate_id" });
  expect(
    await fixture.store.append({
      event: { ...event("collision"), commandId: "different" },
      expectedSequence: 1,
    }),
  ).toEqual({ status: "rejected", reason: "duplicate_id" });
  expect(await Array.fromAsync(fixture.store.readStream("member-bob"))).toEqual(
    [],
  );
  expect(await fixture.store.head()).toBe(1);
});

it("retries through a real restart, then reports unavailable at the ten-second bound", async () => {
  fixture = await natsFixture();
  await fixture.stop();
  const started = performance.now();
  const pending = fixture.store.append({
    event: event("restart"),
    expectedSequence: 0,
  });
  const observed = pending.then((result) => result);
  await delay(600);
  await fixture.restart();
  expect(await observed).toEqual({ status: "appended", sequence: 1 });
  expect(performance.now() - started).toBeLessThan(10_500);
  expect(
    await Array.fromAsync(fixture.store.readStream("member-alice")),
  ).toHaveLength(1);
  await fixture.stop();
  const unavailableAt = performance.now();
  const unavailable = await fixture.store.append({
    event: event("outage"),
    expectedSequence: 1,
  });
  expect(unavailable.status).toBe("unavailable");
  if (unavailable.status === "unavailable") {
    expect(unavailable.cause).toBeInstanceOf(Error);
  }
  expect(performance.now() - unavailableAt).toBeGreaterThanOrEqual(9_900);
  expect(performance.now() - unavailableAt).toBeLessThan(10_750);
  // The checks above bound the retry window. This limit only stops a hung test; it also
  // covers fixture setup (a CA and seven certificates) and NATS restarts on a busy machine.
}, 45_000);

it("keeps global order across read-ahead, aborts mid-history and resumes from the caller's checkpoint", async () => {
  fixture = await natsFixture();
  for (let id = 1; id <= 129; id++) {
    await fixture.store.append({ event: event(String(id), `member-${id}`), expectedSequence: 0 });
  }
  const abort = new AbortController();
  const sequences: number[] = [];
  for await (const stored of fixture.store.subscribe(2, abort.signal)) {
    sequences.push(stored.sequence);
    if (stored.sequence === 66) abort.abort();
  }
  expect(sequences).toEqual(Array.from({ length: 65 }, (_, i) => i + 2));
  const resumed: number[] = [];
  for await (const stored of fixture.store.subscribe(67)) {
    resumed.push(stored.sequence);
    if (stored.sequence === 129) break;
  }
  expect(resumed).toEqual(Array.from({ length: 63 }, (_, i) => i + 67));
  const tailAbort = new AbortController();
  const pending = fixture.store.subscribe(130, tailAbort.signal).next();
  tailAbort.abort();
  expect((await pending).done).toBe(true);
}, 15_000); // Includes TLS setup and 129 real appends on the shared dev host.

it("retries no-responder failures through recovery and the full deadline", async () => {
  fixture = await natsFixture();
  await fixture.stop();
  await fixture.restart(false);
  await expect(jetstreamManager(fixture.connection)).rejects.toMatchObject({
    name: "JetStreamNotEnabled",
  });
  const pending = fixture.store.append({
    event: event("no-responders"),
    expectedSequence: 0,
  });
  await delay(300);
  await fixture.stop();
  await fixture.restart();
  expect(await pending).toEqual({ status: "appended", sequence: 1 });
  expect(await fixture.store.head()).toBe(1);
  await fixture.stop();
  await fixture.restart(false);
  const started = performance.now();
  expect(
    (
      await fixture.store.append({
        event: event("still-unavailable"),
        expectedSequence: 1,
      })
    ).status,
  ).toBe("unavailable");
  expect(performance.now() - started).toBeGreaterThanOrEqual(9_900);
  expect(performance.now() - started).toBeLessThan(10_750);
// The checks above keep the retry window strict. This limit also covers fixture
// setup and three real NATS process starts on a busy machine.
}, 45_000);

async function stopsRetriesAtTheCallerDeadline() {
  fixture = await natsFixture();
  const client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  const store = new EventStore(client, manager);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  let attempts = 0;
  function failPublish(): Promise<never> {
    attempts++;
    clock.mockReturnValue(started + attempts * 2001);
    return Promise.reject(new TimeoutError());
  }
  client.publish = failPublish;
  try {
    const result = await store.append({ event: event('expired-grant'), expectedSequence: 0,
      historyChecked: true, deadline: started + 2000 });
    expect(result.status).toBe('unavailable');
    expect(attempts).toBe(1);
  } finally {
    clock.mockRestore();
  }
  expect(await fixture.store.head()).toBe(0);
}
it('stops append retries at the caller access deadline', stopsRetriesAtTheCallerDeadline);

async function stopsWhenBackoffUsesRemainingPermission() {
  fixture = await natsFixture();
  const client = jetstream(fixture.connection);
  const manager = await jetstreamManager(fixture.connection);
  const store = new EventStore(client, manager);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  let attempts = 0;
  function failPublish(): Promise<never> {
    attempts += 1;
    if (attempts === 1) {
      // Reproduce a timer waking just before the last fraction of permission expires.
      clock.mockReturnValue(started + 9.75);
    } else {
      clock.mockReturnValue(started + 11);
    }
    return Promise.reject(new TimeoutError());
  }
  client.publish = failPublish;
  const command: AppendCommand = { event: event('backoff-uses-permission'), expectedSequence: 0,
    historyChecked: true, deadline: started + 10 };
  try {
    const result = await store.append(command);
    expect(result.status).toBe('unavailable');
    expect(attempts).toBe(1);
  } finally {
    clock.mockRestore();
  }
  expect(await fixture.store.head()).toBe(0);
}
it('does not publish again when backoff uses the last fraction of permission time',
  stopsWhenBackoffUsesRemainingPermission);

async function refusesChangesAfterAccessCheck() {
  fixture = await natsFixture();
  async function checkAccess() {
    const changed = { event: event('access-removed', 'member-bob'), expectedSequence: 0 };
    expect(await fixture.store.append(changed)).toEqual({ status: 'appended', sequence: 1 });
  }
  const command = { event: event('checked-write'), expectedSequence: 0,
    deadline: performance.now() + 2000, historyChecked: true as const, checkAccess };
  expect(await fixture.store.append(command)).toEqual({ status: 'conflict' });
  expect(await fixture.store.head('member-alice')).toBe(0);
}
it('refuses an event saved between the append access check and the conditional publish',
  refusesChangesAfterAccessCheck);

async function refusesExpiryDuringAccessCheck() {
  fixture = await natsFixture();
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  async function checkAccess() {
    clock.mockReturnValue(started + 2001);
  }
  const command = { event: event('expired-access-check'), expectedSequence: 0,
    deadline: started + 2000, historyChecked: true as const, checkAccess };
  try {
    expect(await fixture.store.append(command)).toMatchObject({ status: 'unavailable' });
  } finally {
    clock.mockRestore();
  }
  expect(await fixture.store.head('member-alice')).toBe(0);
}
it('refuses an append when its access check exceeds the original deadline',
  refusesExpiryDuringAccessCheck);
