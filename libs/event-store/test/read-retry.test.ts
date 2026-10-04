import { afterEach, expect, it, vi } from "vitest";
import { TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import type { StoredEvent } from "../src/index.ts";
import { event, natsFixture } from "./testing.ts";

// Node's promise timers bypass Vitest's clock; route this external clock through fakeable timers.
function promiseTimers() {
  function delay(milliseconds: number) {
    function schedule(resolve: () => void) {
      setTimeout(resolve, milliseconds);
    }
    return new Promise<void>(schedule);
  }
  return { setTimeout: delay };
}
vi.mock("node:timers/promises", promiseTimers);

let fixture: Awaited<ReturnType<typeof natsFixture>>;

function storedEvent(id: string, subject = "member-alice") {
  const input = event(id, subject);
  return { ...input, correlation: {}, principal: { kind: "human" as const, id: "admin" } };
}

async function closeFixture() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fixture?.close();
}
afterEach(closeFixture);

async function boundOutage() {
  fixture = await natsFixture();
  fixture.pauseResponses(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let failure: unknown;
  function observeFailure(error: unknown) {
    failure = error;
  }
  const read = fixture.store.head();
  const pending = read.catch(observeFailure);
  await vi.advanceTimersByTimeAsync(999);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toBeInstanceOf(TimeoutError);
  await pending;
}
it("fails a sustained outage at the one-second read bound", boundOutage);

async function callerDeadline() {
  fixture = await natsFixture();
  fixture.pauseResponses(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  let failure: unknown;
  function observeFailure(error: unknown) {
    failure = error;
  }
  const deadline = performance.now() + 100;
  const rows = fixture.store.readStream("member-alice", 1, deadline);
  const pending = Array.fromAsync(rows).catch(observeFailure);
  await vi.advanceTimersByTimeAsync(99);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toBeInstanceOf(TimeoutError);
  await pending;
}
it("honours a caller deadline shorter than the request timeout", callerDeadline);

async function lateReply() {
  fixture = await natsFixture();
  await fixture.seed([storedEvent("late-head")]);
  stallAfterReply(fixture.connection);
  const deadline = performance.now() + 100;
  await expect(fixture.store.head("member-alice", deadline)).rejects.toBeInstanceOf(TimeoutError);
}
it("refuses a late reply after the caller deadline", lateReply);

function stallAfterReply(connection: NatsConnection) {
  const request = connection.request.bind(connection);
  const send: NatsConnection["request"] = async function send(subject, data, options) {
    const reply = await request(subject, data, options);
    if (subject.endsWith("STREAM.MSG.GET.EVENTS")) {
      // The SDK has already received its reply and cancelled its 250 ms timer.
      // Stall for 150 ms so only the caller's 100 ms deadline expires.
      const until = performance.now() + 150;
      while (performance.now() < until) {
        // Deliberate event-loop stall, independent of host load.
      }
    }
    return reply;
  };
  vi.spyOn(connection, "request").mockImplementation(send);
}

async function missingStream() {
  fixture = await natsFixture({ provision: false });
  // A permanent error must finish without advancing the retry clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  await expect(fixture.store.head()).rejects.toMatchObject({ code: 10059 });
}
it("throws a missing-stream service error immediately", missingStream);

async function abortSubscription() {
  fixture = await natsFixture();
  fixture.pauseResponses(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const controller = new AbortController();
  const subscription = fixture.store.subscribe(1, controller.signal);
  let result: IteratorResult<StoredEvent> | undefined;
  let failure: unknown;
  function observeResult(value: IteratorResult<StoredEvent>) {
    result = value;
  }
  function observeFailure(error: unknown) {
    failure = error;
  }
  const read = subscription.next();
  const pending = read.then(observeResult, observeFailure);
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result).toEqual({ done: true, value: undefined });
  expect(failure).toBeUndefined();
  await pending;
}
it("stops subscription retries when the caller aborts", abortSubscription);

function stallNextRequest(connection: NatsConnection, requestSubject: string) {
  const request = connection.request.bind(connection);
  let stalled = false;
  const send: NatsConnection["request"] = function send(subject, data, options) {
    const pending = request(subject, data, options);
    if (!stalled && subject.endsWith(requestSubject)) {
      stalled = true;
      // Block this worker after sending, so its request timer expires before it reads the reply.
      const until = performance.now() + 260;
      while (performance.now() < until) {
        // Deliberate event-loop stall, independent of host load.
      }
    }
    return pending;
  };
  vi.spyOn(connection, "request").mockImplementation(send);
}

async function recoverHead(subject: string | undefined) {
  fixture = await natsFixture();
  await fixture.seed([storedEvent("read-stall")]);
  const requestSubject = subject === undefined ? "STREAM.INFO.EVENTS" : "STREAM.MSG.GET.EVENTS";
  stallNextRequest(fixture.connection, requestSubject);
  expect(await fixture.store.head(subject)).toBe(1);
}
const headSubjects = [undefined, "member-alice", "member-*"];
it.each(headSubjects)("recovers head %s after a 260 ms event-loop stall", recoverHead);

async function recoverHistory(requestSubject: string) {
  fixture = await natsFixture();
  await fixture.seed([storedEvent("history-stall")]);
  stallNextRequest(fixture.connection, requestSubject);
  const rows = await Array.fromAsync(fixture.store.readStream("member-alice"));
  expect(rows).toMatchObject([{ sequence: 1, event: { id: "history-stall" } }]);
}
const historyRequests = ["STREAM.INFO.EVENTS", "STREAM.MSG.GET.EVENTS"];
it.each(historyRequests)("recovers history after stalling %s for 260 ms", recoverHistory);

async function recoverSubscription() {
  fixture = await natsFixture();
  const events = [];
  for (let index = 1; index <= 64; index++) {
    events.push(storedEvent(`subscribe-${index}`, `member-${index}`));
  }
  await fixture.seed(events);
  stallNextRequest(fixture.connection, "STREAM.MSG.GET.EVENTS");
  const sequences = [];
  for await (const row of fixture.store.subscribe()) {
    sequences.push(row.sequence);
    if (row.sequence === 64) {
      break;
    }
  }
  function expectedSequence(_value: unknown, index: number) {
    return index + 1;
  }
  expect(sequences).toEqual(Array.from({ length: 64 }, expectedSequence));
}
it("recovers subscription read-ahead in order after a stall", recoverSubscription);

async function cancelsSiblingReads() {
  fixture = await natsFixture();
  const events = [];
  for (let index = 1; index <= 64; index++) {
    events.push(storedEvent(`cancel-${index}`, `member-${index}`));
  }
  await fixture.seed(events);
  const clockOptions: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ["setTimeout", "clearTimeout", "performance"],
  };
  vi.useFakeTimers(clockOptions);
  const request = fixture.connection.request.bind(fixture.connection);
  let messageReads = 0;
  const send: NatsConnection["request"] = function send(subject, data, options) {
    if (!subject.endsWith("STREAM.MSG.GET.EVENTS")) {
      return request(subject, data, options);
    }
    messageReads++;
    if (messageReads === 1) {
      return Promise.reject(new Error("Permanent read failure"));
    }
    return Promise.reject(new TimeoutError());
  };
  vi.spyOn(fixture.connection, "request").mockImplementation(send);
  const subscription = fixture.store.subscribe();
  await expect(subscription.next()).rejects.toThrow("Permanent read failure");
  const readsAtFailure = messageReads;
  await vi.advanceTimersByTimeAsync(1000);
  expect(messageReads).toBe(readsAtFailure);
}
it("stops sibling subscription retries after the first read fails", cancelsSiblingReads);
