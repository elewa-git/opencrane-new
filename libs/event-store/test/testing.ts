import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { certificates } from "./certificates.ts";
import { getEventDefinition } from "@opencrane/events";
import { createEventStore, connectNats } from "../src/index.ts";

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No test port");
  }
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
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
  return {
    id,
    commandId: id,
    type,
    source: "test",
    time: "2026-10-01T00:00:00Z",
    subject,
    silo: "test",
    principal: { id: "admin", kind: "human" },
    data: { ...definition.example, memberId: subject.slice("member-".length) },
  };
}

export async function natsFixture() {
  const directory = await mkdtemp(resolve(".tools/nats-test-"));
  await certificates(directory);
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
  const port = await freePort();
  const url = `127.0.0.1:${port}`;
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
      NATS_LISTEN: url, NATS_STORE_DIR: `${directory}/store` } });
    const exited = once(process, "exit");
    const ready = new Promise<void>((done, reject) => {
      let output = "";
      process.on("error", reject);
      process.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Server is ready")) {
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
  const readerStore = await createEventStore(readerConnection, "projection-replay");
  const store = await createEventStore(connection);
  await store.ensureStream({ replicas: 1 });
  // Simulate the installation/replay job separately from the unprivileged reader.
  const reader = {
    head: () => readerStore.head(),
    async *subscribe(fromSequence = 1, signal?: AbortSignal) {
      await store.provisionProjection("projection-replay", fromSequence);
      try { yield* readerStore.subscribe(fromSequence, signal); }
      finally {
        const manager = await jetstreamManager(connection);
        await manager.consumers.delete("EVENTS", "projection-replay");
      }
    },
  };
  return {
    store,
    connection,
    reader,
    dispatcherConnection,
    env,
    client,
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
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
      if (
        running.process.exitCode === null &&
        running.process.signalCode === null
      ) {
        running.process.kill("SIGTERM");
        await running.exited;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
