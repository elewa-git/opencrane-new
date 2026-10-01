import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { pgDb, pgliteDb } from "../src/index.ts";

export async function database(kind: "pg" | "pglite") {
  if (kind === "pg") {
    const adminConnectionString = process.env["PG_TEST_URL"];
    if (!adminConnectionString) {
      throw new Error("PG_TEST_URL must allow disposable databases");
    }
    const admin = new Pool({ connectionString: adminConnectionString });
    const name = `projections_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminConnectionString);
    url.pathname = `/${name}`;
    const connectionString = url.href;
    let pool = new Pool({ connectionString });
    return {
      get db() {
        return pgDb(pool);
      },
      async reopen() {
        await pool.end();
        pool = new Pool({ connectionString });
      },
      async close() {
        try {
          await pool.end();
          const deadline = Date.now() + 15_000;
          while ((await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE datname = $1",
            [name],
          )).rows.length > 0) {
            if (Date.now() >= deadline) {
              throw new Error(`Timed out waiting for ${name} to disconnect`);
            }
            await delay(25);
          }
        } finally {
          try {
            await admin.query(`DROP DATABASE IF EXISTS ${name}`);
          } finally {
            await admin.end();
          }
        }
      },
    };
  }
  const directory = await mkdtemp(resolve(".tools/projection-test-"));
  let engine = new PGlite(directory);
  return {
    get db() {
      return pgliteDb(engine);
    },
    async reopen() {
      await engine.close();
      engine = new PGlite(directory);
    },
    async close() {
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
