export { freePort } from "./ports.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
export { TimeoutError } from "@nats-io/transport-node";
import { TimeoutError, type NatsConnection } from "@nats-io/transport-node";
import { certificates, sharedCertificates } from "./certificates.ts";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { wireSubject } from "../src/contract.ts";
import { getEventDefinition, type EventEnvelope } from "@opencrane/events";
import { createEventStore, connectNats, EventStore, systemClock, type Clock } from "../src/index.ts";
import { afterAll, expect, onTestFinished } from "vitest";

function registerChildCleanup(child: ChildProcess) {
  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };
  const removeSignalHandlers = () => {
    process.removeListener("SIGTERM", stopChildOnSigterm);
    process.removeListener("SIGINT", stopChildOnSigint);
  };
  function stopChildOnSigterm() {
    killChild();
    process.kill(process.pid, "SIGTERM");
  }
  function stopChildOnSigint() {
    killChild();
    process.kill(process.pid, "SIGINT");
  }
  process.once("SIGTERM", stopChildOnSigterm);
  process.once("SIGINT", stopChildOnSigint);
  child.once("close", removeSignalHandlers);
  if (expect.getState().currentTestName) {
    onTestFinished(killChild);
  } else {
    afterAll(killChild);
  }
}

/** Keep the public port bound while a child service stops and starts behind it. */
export async function tcpProxy(target: () => { host: string; port: number }, host = "127.0.0.1") {
  const sockets = new Set<Socket>();
  const responses = new Set<Socket>();
  let paused = false;
  const server = createServer((socket) => {
    const upstream = connect(target());
    responses.add(upstream);
    upstream.on("close", () => responses.delete(upstream));
    for (const peer of [socket, upstream]) {
      peer.setNoDelay(true);
      sockets.add(peer);
      peer.on("close", () => { sockets.delete(peer); socket.destroy(); upstream.destroy(); });
      peer.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
    if (paused) upstream.pause();
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No proxy address");
  return {
    port: address.port,
    pauseResponses(this: void, value: boolean) {
      paused = value;
      for (const response of responses) {
        if (value) response.pause(); else response.resume();
      }
    },
    async close() {
      const closed = once(server, "close");
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export function event(
  id: string,
  subject = "member-alice",
  type = "member.joined",
) {
  const definition = getEventDefinition(type);
  if (
    !definition ||
    typeof definition.example !== "object" ||
    definition.example === null
  ) {
    throw new Error("Unknown fixture event");
  }
  const principal: NonNullable<EventEnvelope["principal"]> = { id: "admin", kind: "human" };
  return {
    id,
    commandId: id,
    type,
    source: "test",
    time: "2026-10-01T00:00:00Z",
    subject,
    silo: "test",
    correlation: {},
    principal,
    data: { ...definition.example, memberId: subject.slice("member-".length) },
  };
}

export type AppendEventOptions = Pick<EventEnvelope, 'silo' | 'subject' | 'type' | 'data'> & {
  id?: string;
  source?: EventEnvelope['source'];
  principal?: EventEnvelope['principal'];
  time?: EventEnvelope['time'];
  commandId?: EventEnvelope['commandId'];
};

/** Save fixture data and leave projections to the calling test. */
export async function appendEvent(store: EventStore, options: AppendEventOptions) {
  const { silo, subject, type, data } = options;
  const id = options.id ?? randomUUID();
  const defaults = event(id, subject, type);
  const record = {
    ...defaults, silo, data,
    source: options.source ?? defaults.source,
    principal: options.principal ?? defaults.principal,
    time: options.time ?? defaults.time,
    commandId: options.commandId ?? defaults.commandId,
  };
  const expectedSequence = await store.head(subject);
  const result = await store.append({ event: record, expectedSequence });
  expect(result.status).toBe('appended');
  if (result.status !== 'appended') {
    throw new Error('Fixture event was not appended');
  }
  return { event: record, sequence: result.sequence };
}

export interface NatsFixtureOptions {
  provision?: boolean;
  freshCertificates?: boolean;
  clock?: Clock;
}

export async function natsFixture({ provision = true, freshCertificates = false,
  clock = systemClock }: NatsFixtureOptions = {}) {
  const directory = await mkdtemp(resolve(".tools/nats-test-"));
  if (freshCertificates) {
    await certificates(directory);
  } else {
    await sharedCertificates(directory);
  }
  const publicKeys = Object.fromEntries(await Promise.all(
    ["command", "projection", "dispatcher", "computer", "gateway"].map(async (role) =>
      [`NATS_${role.toUpperCase()}_NKEY`, await readFile(`${directory}/${role}.pub`, "utf8")] as const),
  ));
  const config = await readFile(resolve("infra/nats/nats.conf"), "utf8");
  await writeFile(`${directory}/nats.conf`, config);
  await writeFile(`${directory}/no-js.conf`, config
    .replace("jetstream { store_dir: $NATS_STORE_DIR }", "")
    .replace("jetstream: enabled", "")
    // Remove service routes too: dormant imports otherwise count as responders.
    .replace(/^\s*\{ service:.*\n/gm, ""));
  let targetPort = 0;
  const proxy = await tcpProxy(() => ({ host: "127.0.0.1", port: targetPort }));
  const url = `127.0.0.1:${proxy.port}`;
  function env(identity = "command") {
    return {
      NATS_URL: url,
      NATS_NKEY_SEED_FILE: `${directory}/${identity}.seed`,
      NATS_INBOX_PREFIX: `_INBOX.${identity}`,
      NATS_CA_FILE: `${directory}/ca.crt`,
      NATS_CERT_FILE: `${directory}/${identity}.crt`,
      NATS_KEY_FILE: `${directory}/${identity}.key`,
    };
  }
  const connections: NatsConnection[] = [];
  async function client(identity: string) {
    const connection = await connectNats(env(identity));
    connections.push(connection);
    return connection;
  }
  function start(jetstream = true) {
    const process = spawn(resolve(".tools/nats-server"), [
      "-c", `${directory}/${jetstream ? "nats" : "no-js"}.conf`,
    ], { env: { ...globalThis.process.env, ...env("server"), ...publicKeys,
      NATS_LISTEN: "127.0.0.1:-1", NATS_STORE_DIR: `${directory}/store` } });
    registerChildCleanup(process);
    const exited = once(process, "exit");
    const ready = new Promise<void>((done, reject) => {
      let output = "";
      process.on("error", reject);
      process.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const port = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
        if (port && output.includes("Server is ready")) {
          targetPort = Number(port);
          done();
        }
      });
      process.once("exit", () =>
        reject(new Error(`NATS stopped before ready: ${output}`)),
      );
    });
    return { process, exited, ready };
  }
  let running = start();
  await running.ready;
  const connection = await client("command");
  const readerConnection = await client("projection");
  const dispatcherConnection = await client("dispatcher");
  const readerStore = await createEventStore(readerConnection, clock);
  const store = await createEventStore(connection, clock);
  async function close() {
    for (const connection of connections) {
      await connection.close();
    }
    if (running.process.exitCode === null && running.process.signalCode === null) {
      running.process.kill("SIGTERM");
      await running.exited;
    }
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    if (provision) {
      await store.ensureStream({ replicas: 1 });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    store,
    pauseResponses: proxy.pauseResponses,
    connection,
    reader: readerStore,
    dispatcherConnection,
    env,
    client,
    async dispatcherInfo() {
      const manager = await jetstreamManager(connection);
      return manager.consumers.info("EVENTS", "handler-dispatcher");
    },
    /** Publish known-valid fixture events without command retry lookups. */
    async seed(events: EventEnvelope[]) {
      const js = jetstream(connection);
      await Promise.all(events.map(async event => {
        await js.publish(wireSubject(event.subject), JSON.stringify(event), {
          msgID: event.id, expect: { streamName: "EVENTS" },
        });
      }));
    },
    async stop() {
      if (
        running.process.exitCode === null &&
        running.process.signalCode === null
      ) {
        running.process.kill("SIGTERM");
        await running.exited;
      }
    },
    async restart(jetstream = true) {
      const statuses = connection.status();
      running = start(jetstream);
      await running.ready;
      for await (const status of statuses) {
        if (status.type === "reconnect") {
          break;
        }
      }
    },
    close,
  };
}

export interface ReadCall {
  subject: string;
  fromSequence: number;
  rows: number;
}

/** Count instance reads so append's own history searches are included. */
export function countReads(store: Pick<EventStore, 'readStream'>) {
  const calls: ReadCall[] = [];
  const read = store.readStream.bind(store);
  async function* countedRead(subject: string, fromSequence = 1, deadline = Infinity) {
    const call = { subject, fromSequence, rows: 0 };
    calls.push(call);
    for await (const row of read(subject, fromSequence, deadline)) {
      call.rows++;
      yield row;
    }
  }
  function clear() {
    calls.length = 0;
  }
  store.readStream = countedRead;
  return { calls, clear };
}

export function expectNoWholeReads(calls: ReadCall[], largestAllowed = 20) {
  for (const call of calls) {
    if (call.fromSequence <= 1) {
      expect(call.rows, `Whole-stream read of ${call.subject}`).toBeLessThanOrEqual(largestAllowed);
    }
  }
}

/** Lose a saved publish reply without changing what NATS stores. */
export async function lostReplyStore(connection: NatsConnection) {
  const client = jetstream(connection);
  const manager = await jetstreamManager(connection);
  const store = new EventStore(client, manager);
  const publish = client.publish.bind(client);
  let loseReply = false;
  function loseNextReply() {
    loseReply = true;
  }
  async function dropReply(...args: Parameters<typeof publish>) {
    const acknowledgement = await publish(...args);
    if (loseReply) {
      loseReply = false;
      throw new TimeoutError();
    }
    return acknowledgement;
  }
  client.publish = dropReply;
  return { store, loseNextReply };
}

/** Fail one publish without saving it, then allow retries to reach the real server. */
export async function failingPublishStore(connection: NatsConnection) {
  const client = jetstream(connection);
  const manager = await jetstreamManager(connection);
  const store = new EventStore(client, manager);
  const publish = client.publish.bind(client);
  let beforeFailure: (() => Promise<void>) | undefined;
  let attempts = 0;
  function failNextPublish(callback: () => Promise<void>) {
    beforeFailure = callback;
    attempts = 0;
  }
  async function attemptPublish(...args: Parameters<typeof publish>) {
    attempts += 1;
    const callback = beforeFailure;
    if (callback) {
      beforeFailure = undefined;
      await callback();
      throw new TimeoutError();
    }
    return publish(...args);
  }
  client.publish = attemptPublish;
  function publishAttempts() {
    return attempts;
  }
  return { store, failNextPublish, publishAttempts };
}

export interface ManualClock extends Clock {
  advance(milliseconds: number): void;
}

export function manualClock(started = 0): ManualClock {
  let time = started;
  const sleepers = new Set<() => void>();
  function now() {
    return time;
  }
  function advance(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error('Clock advance must be a finite non-negative duration');
    }
    time += milliseconds;
    for (const wake of sleepers) {
      wake();
    }
  }
  function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    const wakeAt = time + Math.max(0, milliseconds);
    return new Promise<void>(wait);
    function wait(resolve: () => void, reject: (reason: unknown) => void) {
      function clean() {
        sleepers.delete(wake);
        signal?.removeEventListener('abort', abort);
      }
      function wake() {
        if (time >= wakeAt) {
          clean();
          resolve();
        }
      }
      function abort() {
        clean();
        reject(signal?.reason);
      }
      if (signal?.aborted) {
        abort();
        return;
      }
      sleepers.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      wake();
    }
  }
  return { now, advance, sleep };
}
export { substituteStoredContent } from './stored-content.ts';
