import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { pgDb, pgliteDb } from "../src/index.ts";

export async function database(kind: "pg" | "pglite") {
  if (kind === "pg") {
    const connectionString = process.env["PG_TEST_URL"];
    if (!connectionString) {
      throw new Error("PG_TEST_URL must point at a disposable database");
    }
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
        await pool.end();
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
