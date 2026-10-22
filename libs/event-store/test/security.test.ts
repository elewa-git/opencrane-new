import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { issueCertificate } from "./certificates.ts";
import { connect as tcpConnect } from "node:net";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { connect, nkeyAuthenticator, nkeys, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connectNats, createEventStore } from "../src/index.ts";
import { event, natsFixture } from "./testing.ts";

let fixture: Awaited<ReturnType<typeof natsFixture>>;
beforeAll(async () => { fixture = await natsFixture(); });
afterAll(async () => { await fixture?.close(); });

async function consumerFixture() {
  const isolated = await natsFixture();
  onTestFinished(isolated.close);
  const manager = await jetstreamManager(isolated.connection);
  for (const role of ['projection', 'dispatcher']) {
    const name = role === 'projection' ? 'projection-members' : 'handler-dispatcher';
    await manager.consumers.add('EVENTS', {
      durable_name: name,
      filter_subject: 'ev.>',
      ack_policy: role === 'projection' ? AckPolicy.None : AckPolicy.Explicit,
    });
  }
  return isolated;
}

// Core publish errors arrive asynchronously. Assert NATS's actual refusal,
// not just a request timeout (which could also mean a broken test server).
async function refused(connection: NatsConnection, subject: string, operation = "publish", payload = "{}") {
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
    if (!subscription) connection.publish(subject, payload);
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
  // Provisioning is a separate operator step. Readers only bind existing consumers.
  const manager = await jetstreamManager(fixture.connection);
  const name = identity === "projection" ? "projection-members" : "handler-dispatcher";
  await manager.consumers.add("EVENTS", { durable_name: name,
    filter_subject: "ev.>", ack_policy: identity === "projection" ? AckPolicy.None : AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: previousHead + 1 });
  const consumer = await jetstream(connection).consumers.get("EVENTS", name);
  const message = await consumer.next({ expires: 1000 });
  expect(message?.seq).toBe(previousHead + 1);
  expect(message?.json()).toEqual(command);
  if (identity === "dispatcher") expect(await message?.ackAck()).toBe(true);
  expect((await Array.fromAsync(reader.readStream(command.subject))).map(({ event }) => event))
    .toEqual([command]);
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

it("closes a NATS fixture created inside a test", async () => {
  const testFixture = await natsFixture();
  await testFixture.close();
  expect(testFixture.store).toBeDefined();
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

it.each(["DNS", "email", "URI"])("%s SAN cannot select the command role", async (kind) => {
  const directory = dirname(fixture.env().NATS_CERT_FILE);
  const name = `spoof-${kind}`;
  await issueCertificate(directory, name, "/CN=unknown",
    `extendedKeyUsage=clientAuth\nsubjectAltName=${kind}:CN=command\n`);
  const spoof = { ...fixture.env("unknown"),
    NATS_CERT_FILE: `${directory}/${name}.crt`, NATS_KEY_FILE: `${directory}/${name}.key` };
  await expect(connectNats(spoof)).rejects.toThrow(/authorization/i);
  for (const role of ["projection", "dispatcher", "computer", "gateway"]) {
    const connection = await connectNats({ ...fixture.env(role),
      NATS_CERT_FILE: spoof.NATS_CERT_FILE, NATS_KEY_FILE: spoof.NATS_KEY_FILE });
    try { await refused(connection, "ev.member.spoof"); }
    finally { await connection.close(); }
  }
});

it("a command CN, chosen inbox or forged NKey claim cannot grant command rights", async () => {
  const env = fixture.env();
  const options = {
    servers: env.NATS_URL, reconnect: false, timeout: 1000,
    tls: { caFile: env.NATS_CA_FILE, certFile: env.NATS_CERT_FILE,
      keyFile: env.NATS_KEY_FILE, handshakeFirst: true },
  };
  const seed = await readFile(fixture.env("projection").NATS_NKEY_SEED_FILE);
  const connection = await connect({ ...options, inboxPrefix: "_INBOX.command",
    authenticator: nkeyAuthenticator(seed) });
  try {
    await refused(connection, "ev.member.spoof");
    await refused(connection, "_INBOX.command.stolen", "subscription");
  } finally { await connection.close(); }
  await expect(connect(options)).rejects.toThrow(/authorization/i);
  await expect(connect({ ...options, user: "CN=command", pass: "command" }))
    .rejects.toThrow(/authorization/i);
  const command = nkeys.fromSeed(await readFile(env.NATS_NKEY_SEED_FILE));
  try {
    await expect(connect({ ...options, authenticator: (nonce) => ({
      sig: Buffer.from(nkeys.fromSeed(seed).sign(new TextEncoder().encode(nonce))).toString("base64url"),
      nkey: command.getPublicKey(),
    }) })).rejects.toThrow(/authorization/i);
  } finally { command.clear(); }
});

it("refuses a TLS client without credentials", async () => {
  await expect(connect({ servers: fixture.env().NATS_URL,
    tls: { caFile: fixture.env().NATS_CA_FILE, handshakeFirst: true },
    reconnect: false, timeout: 1000 })).rejects.toThrow();
});

it("refuses a server signed by the wrong CA", async () => {
  const other = await natsFixture({ freshCertificates: true });
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

it.each(["NATS_URL", "NATS_CA_FILE", "NATS_CERT_FILE", "NATS_KEY_FILE", "NATS_NKEY_SEED_FILE", "NATS_INBOX_PREFIX"])("fails closed without %s", async (name) => {
  await expect(connectNats({ ...fixture.env(), [name]: "" })).rejects.toThrow(`${name} is required`);
});

it.each(["NATS_KEY_FILE", "NATS_NKEY_SEED_FILE"])("fails closed when %s is absent", async (name) => {
  await expect(connectNats({ ...fixture.env(), [name]: "/nonexistent/nats.key" })).rejects.toThrow();
});

it("fails closed when the NKey seed is malformed", async () => {
  await expect(connectNats({ ...fixture.env(), NATS_NKEY_SEED_FILE: fixture.env().NATS_CERT_FILE }))
    .rejects.toThrow();
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

it.each(["projection", "dispatcher"])("%s cannot administer or consume another role's consumers", async (role) => {
  // Create both consumers here so this check also works when tests are shuffled.
  const isolated = await consumerFixture();
  const connection = await isolated.client(role);
  const manager = await jetstreamManager(isolated.connection);
  const own = role === "projection" ? "projection-members" : "handler-dispatcher";
  const other = role === "projection" ? "handler-dispatcher" : "projection-members";
  const before = await Promise.all([own, other].map((name) => manager.consumers.info("EVENTS", name)));
  for (const name of [own, other, "outside", `${role}-arbitrary`]) {
    for (const config of [
      { durable_name: name, filter_subject: "ev.>" },
      { durable_name: name, filter_subject: "ev.member.*", deliver_subject: "_INBOX.command.attack" },
      { durable_name: name, filter_subjects: ["ev.>", "other.>"], deliver_subject: "ev.member.attack" },
    ]) {
      const body = JSON.stringify({ stream_name: "EVENTS", config: { ack_policy: "explicit", ...config } });
      for (const subject of [
        "$JS.API.CONSUMER.CREATE.EVENTS",
        `$JS.API.CONSUMER.CREATE.EVENTS.${name}`,
        `$JS.API.CONSUMER.CREATE.EVENTS.${name}.ev.>`,
        `$JS.API.CONSUMER.DURABLE.CREATE.EVENTS.${name}`,
      ]) await refused(connection, subject, "publish", body);
    }
    await refused(connection, `$JS.API.CONSUMER.DELETE.EVENTS.${name}`);
    await refused(connection, `$JS.API.CONSUMER.RESET.EVENTS.${name}`);
    await refused(connection, `$JS.API.CONSUMER.PAUSE.EVENTS.${name}`);
  }
  for (const subject of [
    `$JS.API.CONSUMER.INFO.EVENTS.${other}`,
    `$JS.API.CONSUMER.MSG.NEXT.EVENTS.${other}`,
    `$JS.ACK.EVENTS.${other}.1.1.1.1.0`,
  ]) await refused(connection, subject);
  await refused(connection, `_INBOX.${role === "projection" ? "dispatcher" : "projection"}.attack`, "subscription");
  const after = await Promise.all([own, other].map((name) => manager.consumers.info("EVENTS", name)));
  expect(after.map(({ config, delivered, ack_floor }) => ({ config, delivered, ack_floor })))
    .toEqual(before.map(({ config, delivered, ack_floor }) => ({ config, delivered, ack_floor })));
  for (const name of ["outside", `${role}-arbitrary`]) {
    await expect(manager.consumers.info("EVENTS", name)).rejects.toMatchObject({ code: 10014 });
  }
});

it.each(["projection", "dispatcher"])("%s cannot route API replies or pulled events into EVENT_CORE", async (role) => {
  const connection = await fixture.client(role);
  const own = role === "projection" ? "projection-members" : "handler-dispatcher";
  const head = await fixture.store.head();
  const trapped = fixture.connection.subscribe("_INBOX.command.trap", { timeout: 500 });
  for (const reply of ["_INBOX.command.trap", "ev.member.injected"]) {
    connection.publish("$JS.API.STREAM.MSG.GET.EVENTS", JSON.stringify({ seq: 1 }), { reply });
    connection.publish(`$JS.API.CONSUMER.MSG.NEXT.EVENTS.${own}`,
      JSON.stringify({ batch: 1, expires: 100_000_000 }), { reply });
  }
  await connection.flush();
  await expect((async () => { for await (const message of trapped) return message; return undefined; })())
    .rejects.toThrow(/timeout/i);
  expect(await fixture.store.head()).toBe(head);
});
