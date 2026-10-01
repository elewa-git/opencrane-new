import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { freePort } from "@opencrane/event-store/testing";

const exec = promisify(execFile);
const image =
  "openfga/openfga:v1.21.0@sha256:2113c664a486b5da8d7a2cdab479e0d4e30639c80fd2c000540f645c1dbc1e55";
async function docker(...args: string[]) {
  return (await exec("docker", args, { timeout: 120_000 })).stdout.trim();
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
  const port = await freePort();
  const grpc = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const database = postgres
    ? ["--datastore-engine", "postgres", "--datastore-uri", postgres]
    : ["--datastore-engine", "memory"];
  if (postgres) {
    await docker(
      "run",
      "--rm",
      "--network",
      "host",
      image,
      "migrate",
      ...database,
    );
  }
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    image,
    "run",
    ...database,
    "--http-addr",
    `127.0.0.1:${port}`,
    "--grpc-addr",
    `127.0.0.1:${grpc}`,
    "--metrics-enabled=false",
    "--playground-enabled=false",
    "--log-level",
    "error",
  );
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
    await docker("rm", "-f", name);
    throw error;
  }
  return {
    apiUrl,
    async pause() {
      await docker("pause", name);
    },
    async resume() {
      await docker("unpause", name);
      await ready();
    },
    async restart() {
      await docker("restart", name);
      await ready();
    },
    async close() {
      await docker("rm", "-f", name);
    },
  };
}

export async function databases() {
  let container: string | undefined;
  let url = process.env["PG_TEST_URL"];
  if (!url) {
    const port = await freePort();
    container = await docker(
      "run",
      "-d",
      "--rm",
      "-p",
      `127.0.0.1:${port}:5432`,
      "-e",
      "POSTGRES_PASSWORD=test",
      "postgres:17.6-alpine",
    );
    url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
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
  const postgres = process.env["OPENFGA_TEST_PG_URL"] ?? (await create());
  return {
    queue,
    postgres,
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
      }
    },
  };
}
