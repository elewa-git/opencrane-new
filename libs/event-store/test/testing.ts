import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { certificates } from "./certificates.ts";
import { jetstream } from "@nats-io/jetstream";
import { wireSubject } from "../src/contract.ts";
import { getEventDefinition, type EventEnvelope } from "@opencrane/events";
import { createEventStore, connectNats } from "../src/index.ts";
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

export async function natsFixture({ provision = true } = {}) {
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
  const readerStore = await createEventStore(readerConnection);
  const store = await createEventStore(connection);
  if (provision) await store.ensureStream({ replicas: 1 });
  return {
    store,
    pauseResponses: proxy.pauseResponses,
    connection,
    reader: readerStore,
    dispatcherConnection,
    env,
    client,
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
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
      if (
        running.process.exitCode === null &&
        running.process.signalCode === null
      ) {
        running.process.kill("SIGTERM");
        await running.exited;
      }
      await proxy.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
