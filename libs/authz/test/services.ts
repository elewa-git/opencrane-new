import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { tcpProxy } from "@opencrane/event-store/testing";

const exec = promisify(execFile);
const containers = new Set<string>();
const fixtureLabelValue = String(process.pid);
const fixtureLabel = `opencrane.test.process=${fixtureLabelValue}`;
const image =
  "openfga/openfga:v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55";
async function docker(...args: string[]) {
  return (await exec("docker", args, { timeout: 120_000 })).stdout.trim();
}
function reapContainers() {
  for (const id of containers) {
    const inspected = spawnSync("docker", [
      "inspect", "--format", '{{ index .Config.Labels "opencrane.test.process" }}', id,
    ], { encoding: "utf8", timeout: 10_000 });
    if (inspected.status === 0 && inspected.stdout.trim() === fixtureLabelValue) {
      spawnSync("docker", ["rm", "-f", id], { stdio: "ignore", timeout: 10_000 });
    }
  }
}
process.once("exit", reapContainers);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    reapContainers();
    process.kill(process.pid, signal);
  });
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for service outcome");
    }
    await delay(20);
  }
}

export async function openfga(postgres?: string) {
  const name = `authz-${randomUUID()}`;
  // The container reaches loopback-only control databases through a bound relay.
  let relay: Awaited<ReturnType<typeof tcpProxy>> | undefined;
  if (postgres) {
    const address = new URL(postgres);
    const gateway = await docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}");
    relay = await tcpProxy(() => ({ host: address.hostname, port: Number(address.port || 5432) }), gateway);
    const forwarded = new URL(postgres);
    forwarded.hostname = gateway;
    forwarded.port = String(relay.port);
    postgres = forwarded.href;
  }
  const database = postgres
    ? ["--datastore-engine", "postgres", "--datastore-uri", postgres]
    : ["--datastore-engine", "memory"];
  if (postgres) {
    await docker(
      "run",
      "--rm",
      image,
      "migrate",
      ...database,
    );
  }
  const container = await docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    fixtureLabel,
    "-p",
    "127.0.0.1::8080",
    image,
    "run",
    ...database,
    "--http-addr",
    "0.0.0.0:8080",
    "--grpc-addr",
    "0.0.0.0:8081",
    "--metrics-enabled=false",
    "--playground-enabled=false",
    "--log-level",
    "error",
  );
  containers.add(container);
  let httpPort = Number((await docker("port", container, "8080/tcp")).split(":")[1]);
  const proxy = await tcpProxy(() => ({ host: "127.0.0.1", port: httpPort }));
  const apiUrl = `http://127.0.0.1:${proxy.port}`;
  const ready = () =>
    until(async () => {
      try {
        return (
          await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {
        return false;
      }
    });
  try {
    await ready();
  } catch (error) {
    await docker("rm", "-f", container);
    containers.delete(container);
    await proxy.close();
    await relay?.close();
    throw error;
  }
  return {
    apiUrl,
    async pause() {
      await docker("pause", container);
    },
    async resume() {
      await docker("unpause", container);
      await ready();
    },
    async restart() {
      await docker("restart", container);
      httpPort = Number((await docker("port", container, "8080/tcp")).split(":")[1]);
      await ready();
    },
    async close() {
      await docker("rm", "-f", container);
      containers.delete(container);
      await proxy.close();
      await relay?.close();
    },
  };
}

export async function databases() {
  let container: string | undefined;
  let url = process.env["PG_TEST_URL"];
  if (!url) {
    const name = `authz-postgres-${randomUUID()}`;
    container = await docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "--label",
      fixtureLabel,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD=test",
      "postgres:17.6-alpine",
    );
    containers.add(container);
    url = `postgres://postgres:test@${await docker("port", container, "5432/tcp")}/postgres`;
  }
  const admin = new Pool({ connectionString: url });
  await until(async () => {
    try {
      await admin.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  });
  const names: string[] = [];
  async function create() {
    const name = `authz_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    names.push(name);
    const address = new URL(url ?? "");
    address.pathname = `/${name}`;
    return address.href;
  }
  const queue = new Pool({ connectionString: await create() });
  let postgres: Promise<string> | undefined;
  return {
    queue,
    // Most tests only use the queue database. Do not create and drop an unused database.
    postgres() {
      return postgres ??= process.env["OPENFGA_TEST_PG_URL"]
        ? Promise.resolve(process.env["OPENFGA_TEST_PG_URL"])
        : create();
    },
    async close() {
      await queue.end();
      for (const name of names) {
        // pool.end() can resolve before PostgreSQL has observed the final disconnect.
        await until(async () => (await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = $1", [name],
        )).rows.length === 0);
        await admin.query(`DROP DATABASE ${name}`);
      }
      await admin.end();
      if (container) {
        await docker("rm", "-f", container);
        containers.delete(container);
      }
    },
  };
}
