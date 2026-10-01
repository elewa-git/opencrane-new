import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { getEventDefinition } from "@opencrane/events";
import { createEventStore } from "../src/index.ts";

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
  const port = await freePort();
  const url = `127.0.0.1:${port}`;
  function start(jetstream = true) {
    const process = spawn(resolve(".tools/nats-server"), [
      ...(jetstream ? ["-js"] : []),
      "-a",
      "127.0.0.1",
      "-p",
      String(port),
      "-sd",
      directory,
    ]);
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
  const connection = await connect({
    servers: url,
    reconnectTimeWait: 25,
    reconnectJitter: 0,
    maxReconnectAttempts: -1,
  });
  const store = await createEventStore(connection);
  await store.ensureStream({ replicas: 1 });
  return {
    store,
    connection,
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
      await connection.close();
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
