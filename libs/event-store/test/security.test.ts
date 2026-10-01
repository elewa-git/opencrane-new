import { connect as tcpConnect } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connect, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectNats, createEventStore } from "../src/index.ts";
import { event, natsFixture } from "./testing.ts";

let fixture: Awaited<ReturnType<typeof natsFixture>>;
beforeAll(async () => { fixture = await natsFixture(); });
afterAll(async () => { await fixture?.close(); });

// Core publish errors arrive asynchronously. Assert NATS's actual refusal,
// not just a request timeout (which could also mean a broken test server).
async function refused(connection: NatsConnection, subject: string, operation = "publish") {
  const statuses = connection.status();
  const refusal = (async () => {
    for await (const status of statuses) {
      if (status.type === "error" && status.error instanceof PermissionViolationError) {
        return status.error;
      }
    }
    throw new Error("Connection ended without a permission refusal");
  })();
  const subscription = operation === "subscription" ? connection.subscribe(subject) : undefined;
  try {
    if (!subscription) connection.publish(subject, "{}");
    await expect(refusal).resolves.toMatchObject({ operation, subject });
  } finally {
    subscription?.unsubscribe();
  }
}

it.each(["projection", "dispatcher"])("%s consumes EVENTS but cannot append or change streams", async (identity) => {
  const connection = await fixture.client(identity);
  const reader = await createEventStore(connection);
  const previousHead = await fixture.store.head();
  const command = { ...event(`security-${identity}`, `member-${identity}`), correlation: {} };
  expect(await fixture.store.append({ event: command, expectedSequence: 0 }))
    .toEqual({ status: "appended", sequence: previousHead + 1 });
  const consumer = reader.subscribe(previousHead + 1);
  try {
    expect((await consumer.next()).value).toEqual({ sequence: previousHead + 1, event: command });
  } finally {
    await consumer.return(undefined);
  }
  const manager = await jetstreamManager(fixture.connection);
  const before = (await manager.streams.info("EVENTS")).config;
  for (const subject of [
    "ev.member.attack", "$JS.API.STREAM.CREATE.EVENTS", "$JS.API.STREAM.CREATE.OTHER",
    "$JS.API.STREAM.UPDATE.EVENTS", "$JS.API.STREAM.DELETE.EVENTS",
    "$JS.API.STREAM.PURGE.EVENTS", "$JS.API.STREAM.MSG.DELETE.EVENTS",
    "$JS.API.STREAM.RESTORE.EVENTS", "$JS.API.STREAM.SNAPSHOT.EVENTS",
    "$JS.API.STREAM.INFO.OTHER", "$JS.API.CONSUMER.CREATE.OTHER.attack",
  ]) await refused(connection, subject);
  await refused(connection, "ev.>", "subscription");
  expect(await fixture.store.head()).toBe(previousHead + 1);
  expect((await manager.streams.info("EVENTS")).config).toEqual(before);
  expect((await Array.fromAsync(fixture.store.readStream(command.subject))).map(({ event }) => event))
    .toEqual([command]);
});

it.each(["computer", "gateway"])("%s cannot access events or JetStream", async (identity) => {
  const connection = await fixture.client(identity);
  const head = await fixture.store.head();
  for (const subject of ["ev.>", "ev.member.attack", ">", "_INBOX.attack"]) {
    await refused(connection, subject, "subscription");
  }
  for (const subject of [
    "ev.member.attack", "$JS.API.INFO", "$JS.API.STREAM.INFO.EVENTS",
    "$JS.API.STREAM.MSG.GET.EVENTS", "$JS.API.STREAM.CREATE.EVENTS",
    "$JS.API.STREAM.UPDATE.EVENTS", "$JS.API.CONSUMER.CREATE.EVENTS.attack",
    "$JS.API.CONSUMER.MSG.NEXT.EVENTS.attack", "$JS.ACK.EVENTS.attack",
  ]) await refused(connection, subject);
  expect(await fixture.store.head()).toBe(head);
});

it("refuses an unknown identity even with a certificate signed by the trusted CA", async () => {
  await expect(connectNats(fixture.env("unknown"))).rejects.toThrow(/authorization/i);
});

it("refuses a TLS client without credentials", async () => {
  await expect(connect({ servers: fixture.env().NATS_URL,
    tls: { caFile: fixture.env().NATS_CA_FILE, handshakeFirst: true },
    reconnect: false, timeout: 1000 })).rejects.toThrow();
});

it("refuses a server signed by the wrong CA", async () => {
  const other = await natsFixture();
  try {
    await expect(connectNats({ ...fixture.env(), NATS_CA_FILE: other.env().NATS_CA_FILE }))
      .rejects.toThrow(/certificate|issuer|self.signed/i);
  } finally { await other.close(); }
});

it("refuses plaintext NATS commands before sending protocol information", async () => {
  const address = new URL(`tls://${fixture.env().NATS_URL}`);
  const head = await fixture.store.head();
  const response = await new Promise<string>((resolve, reject) => {
    let data = "";
    const socket = tcpConnect(Number(address.port), address.hostname);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Plaintext socket stayed open")); });
    socket.on("connect", () => socket.write('CONNECT {}\r\nPUB ev.member.attack 2\r\n{}\r\nPING\r\n'));
    socket.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
    socket.on("close", () => resolve(data));
  });
  expect(response).not.toMatch(/INFO|PONG/);
  expect(await fixture.store.head()).toBe(head);
});

it.each(["NATS_URL", "NATS_CA_FILE", "NATS_CERT_FILE", "NATS_KEY_FILE"])("fails closed without %s", async (name) => {
  await expect(connectNats({ ...fixture.env(), [name]: "" })).rejects.toThrow(`${name} is required`);
});

it("fails closed when the key file is absent", async () => {
  await expect(connectNats({ ...fixture.env(), NATS_KEY_FILE: "/nonexistent/nats.key" })).rejects.toThrow();
});

it("does not accept credentials embedded in a URL", async () => {
  await expect(connectNats({ ...fixture.env(), NATS_URL: "nats://user:password@localhost:4222" }))
    .rejects.toThrow("without credentials");
});

it("limits the command identity's JetStream API access to EVENTS", async () => {
  await refused(fixture.connection, "$JS.API.STREAM.CREATE.OTHER");
  await refused(fixture.connection, "$JS.API.STREAM.INFO.OTHER");
  await refused(fixture.connection, "$JS.API.CONSUMER.CREATE.OTHER.attack");
});
