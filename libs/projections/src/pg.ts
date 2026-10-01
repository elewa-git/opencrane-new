import { Pool as PgPool, type Pool } from "pg";
import { memberStateSchema } from "@opencrane/protocol";
import type { Db } from "./db.ts";

/** The caller owns the pool, TLS settings and pool error listener. */
export function pgDb(pool: Pool): Db {
  return {
    query: (sql, parameters) => pool.query(sql, parameters),
    async transaction(work) {
      const client = await pool.connect();
      let released = false;
      try {
        await client.query("BEGIN");
        const result = await work({
          query: (sql, parameters) => client.query(sql, parameters),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          client.release(true);
          released = true;
          throw new AggregateError(
            [error, rollbackError],
            "Projection transaction and rollback failed",
            { cause: rollbackError },
          );
        }
        throw error;
      } finally {
        // release after rollback failure was already handled above.
        if (!released) {
          client.release();
        }
      }
    },
  };
}

/** LISTEN is ready before callers read, so a commit during catch-up cannot be missed. */
export async function connectMemberFeed(connectionString: string) {
  const pool = new PgPool({ connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  const listeners = new Set<() => void>();
  let failed = false;
  const wake = () => { for (const listener of listeners) listener(); };
  const fail = () => { failed = true; wake(); };
  pool.on('error', fail);
  const client = await pool.connect();
  client.on('error', fail);
  client.on('notification', wake);
  try {
    await client.query('LISTEN members_changed');
  } catch (error) {
    client.release(true);
    await pool.end();
    throw error;
  }
  function check() { if (failed) throw new Error('Members feed unavailable'); }
  return {
    listen(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async memberId(silo: string, issuer: string, sub: string) {
      check();
      const result = await pool.query<{ member_id: string }>(`SELECT i.member_id FROM member_identities i
        JOIN members m USING (silo, member_id)
        WHERE i.silo = $1 AND i.issuer = $2 AND i.sub = $3 AND m.status = 'joined'`, [silo, issuer, sub]);
      // Ambiguous bindings are refused too; never choose a person's identity by row order.
      return result.rows.length === 1 ? result.rows[0]?.member_id : undefined;
    },
    async head(silo: string) {
      check();
      const result = await pool.query<{ position: string }>(
        'SELECT COALESCE(MAX(position), 0) AS position FROM member_changes WHERE silo = $1', [silo]);
      return Number(result.rows[0]?.position);
    },
    async read(silo: string, since: number) {
      check();
      const result = await pool.query<{ position: string; member: unknown }>(
        'SELECT position, member FROM member_changes WHERE silo = $1 AND position > $2 ORDER BY position LIMIT 100', [silo, since]);
      return result.rows.map((row) => ({ position: Number(row.position), member: memberStateSchema.parse(row.member) }));
    },
    async close() {
      failed = true;
      listeners.clear();
      client.release(true);
      await pool.end();
    },
  };
}
