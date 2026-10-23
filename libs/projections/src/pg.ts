import { Pool as PgPool, type Pool, type PoolClient } from "pg";
import { toolPolicySchema, memberStateSchema } from "@opencrane/protocol";
import { QueryDeadlineExceeded, type Db } from "./db.ts";
import { mapMcpCatalogueRows, type McpCatalogueRow } from './mcp-catalogue.ts';
import { mapComputerRows, type ComputerDbRow } from './computers.ts';

function clientDb(client: PoolClient): Db {
  return {
    query(sql, parameters, options) {
      if (!options) return client.query(sql, parameters);
      const query = { text: sql, values: parameters ?? [],
        query_timeout: remainingQueryTime(options.deadline) };
      return client.query(query);
    },
    async transaction(work) {
      try {
        await client.query("BEGIN");
        const result = await work({
          query: (sql, parameters) => client.query(sql, parameters),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          throw new AggregateError(
            [error, rollbackError],
            "Projection transaction and rollback failed",
            { cause: rollbackError },
          );
        });
        throw error;
      }
    },
    lock: (_name, work) => work(clientDb(client)),
  };
}

/** The caller owns the pool, TLS settings and pool error listener. */
export function pgDb(pool: Pool): Db {
  return {
    query(sql, parameters, options) {
      if (options) return queryBeforeDeadline(pool, sql, parameters, options.deadline);
      return pool.query(sql, parameters);
    },
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
    async lock(name, work, options) {
      const client = await acquireProjectionLock(pool, name, options);
      let lost = false;
      function failed() {
        lost = true;
      }
      client.on('error', failed);
      try {
        options?.signal?.throwIfAborted();
        // Keep this session checked out until the callback has stopped its work.
        const result = await work(clientDb(client));
        if (lost) throw new Error('Database lock session lost');
        return result;
      } finally {
        try {
          await releaseProjectionLock(client, name, lost, options !== undefined);
        } finally {
          client.removeListener('error', failed);
        }
      }
    },
  };
}

async function releaseProjectionLock(client: PoolClient, name: string, lost: boolean,
  resetTimeout: boolean) {
  try {
    if (!lost) {
      const unlock = { text: 'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        values: [`opencrane:projection:${name}`], query_timeout: 1000 };
      await client.query(unlock);
      if (resetTimeout) {
        const reset = { text: 'RESET lock_timeout', query_timeout: 1000 };
        await client.query(reset);
      }
    }
  } catch (error) {
    client.release(true);
    throw error;
  }
  client.release(lost);
}

async function acquireProjectionLock(pool: Pool, name: string,
  options?: { timeoutMs: number; signal?: AbortSignal }) {
  options?.signal?.throwIfAborted();
  const expired = Promise.withResolvers<never>();
  const deadline = options ? performance.now() + options.timeoutMs : Infinity;
  let client: PoolClient | undefined;
  let stopped = false;
  let released = false;
  function release() {
    if (client && !released) {
      released = true;
      client.release(true);
    }
  }
  function cancel() {
    stopped = true;
    release();
    expired.reject(new Error('Database lock acquisition cancelled or expired'));
  }
  function connectionFailed() {
    cancel();
  }
  async function acquire() {
    client = await pool.connect();
    // Return a connection that arrived after the acquisition deadline without using it.
    if (isStopped()) {
      release();
      throw new Error('Database lock acquisition expired');
    }
    client.on('error', connectionFailed);
    await waitForProjectionLock(client, name, options?.timeoutMs, isStopped);
    if (isStopped()) throw new Error('Database lock acquisition expired');
    return client;
  }
  function isStopped() {
    return stopped || performance.now() >= deadline;
  }
  const timer = options ? setTimeout(cancel, options.timeoutMs) : undefined;
  options?.signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([acquire(), expired.promise]);
  } catch (error) {
    stopped = true;
    release();
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', cancel);
    client?.removeListener('error', connectionFailed);
  }
}

async function waitForProjectionLock(client: PoolClient, name: string,
  timeoutMs: number | undefined, stopped: () => boolean) {
  if (timeoutMs !== undefined) {
    // Let PostgreSQL notice a cancelled socket even while another session holds the lock.
    const interval = Math.max(1, Math.min(100, timeoutMs));
    await client.query("SELECT set_config('lock_timeout', $1, false)", [`${interval}ms`]);
  }
  while (!stopped()) {
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [`opencrane:projection:${name}`]);
      if (timeoutMs !== undefined) {
        // Preserve the caller's timeout for SQL lock waits inside the callback too.
        await client.query("SELECT set_config('lock_timeout', $1, false)", [`${timeoutMs}ms`]);
      }
      return;
    } catch (error) {
      const lockTimedOut = error instanceof Error && 'code' in error && error.code === '55P03';
      if (timeoutMs === undefined || !lockTimedOut) throw error;
    }
  }
  throw new Error('Database lock acquisition cancelled or expired');
}

function remainingQueryTime(deadline: number) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new QueryDeadlineExceeded();
  return remaining;
}

async function queryBeforeDeadline<Row extends Record<string, unknown>>(pool: Pool,
  sql: string, parameters: unknown[] | undefined, deadline: number): Promise<{ rows: Row[] }> {
  const expired = Promise.withResolvers<never>();
  function expire() {
    expired.reject(new QueryDeadlineExceeded());
  }
  const timer = setTimeout(expire, remainingQueryTime(deadline));
  async function read() {
    const client = await pool.connect();
    let completed = false;
    try {
      // Check again after waiting for a connection. Never start an expired query.
      remainingQueryTime(deadline);
      await client.query('BEGIN');
      const timeout = `${remainingQueryTime(deadline)}ms`;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [timeout]);
      const result = await client.query<Row>(sql, parameters);
      remainingQueryTime(deadline);
      await client.query('COMMIT');
      completed = true;
      return result;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '57014') {
        throw new QueryDeadlineExceeded();
      }
      throw error;
    } finally {
      // Destroy failed connections to roll back and clear their local timeout.
      client.release(!completed);
    }
  }
  try {
    // Bound pool acquisition as well as SQL. A late connection is released by read().
    return await Promise.race([read(), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export function connectProjectionDb(
  connectionString: string,
  onError: (error: Error) => void,
) {
  const pool = new PgPool({ connectionString, connectionTimeoutMillis: 1000 });
  pool.on("error", onError);
  return { db: pgDb(pool), close: () => pool.end() };
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
    async generation() {
      check();
      const result = await pool.query<{ generation: string }>(
        "SELECT generation FROM projection_generations WHERE name = 'members'",
      );
      const generation = Number(result.rows[0]?.generation);
      if (!Number.isSafeInteger(generation)) throw new Error('Members generation unavailable');
      return generation;
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

export function connectMcpCatalogue(connectionString: string) {
  const pool = new PgPool({ connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  pool.on('error', () => undefined);
  return {
    async tools(silo: string, serverId: string) {
      const result = await pool.query<{ policy: unknown }>('SELECT policy FROM mcp_catalogue WHERE silo = $1 AND server_id = $2', [silo, serverId]);
      return toolPolicySchema.parse(result.rows[0]?.policy);
    },
    async rows(silo: string) {
      const result = await pool.query<McpCatalogueRow>(`SELECT c.*,
        ARRAY_REMOVE(ARRAY_AGG(m.mode), NULL) AS modes
        FROM mcp_catalogue c LEFT JOIN mcp_tool_modes m USING (silo, server_id)
        WHERE c.silo = $1 GROUP BY c.silo, c.server_id ORDER BY c.position, c.server_id`, [silo]);
      return mapMcpCatalogueRows(result.rows);
    },
    close: () => pool.end(),
  };
}

export function connectComputers(connectionString: string) {
  const pool = new PgPool({ connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  pool.on('error', () => undefined);
  return {
    async rows(silo: string) {
      const result = await pool.query<ComputerDbRow>(`SELECT assistant_id, owner_id, kind, computer_id,
        generation, status, changed_at FROM computers WHERE silo = $1 ORDER BY position, assistant_id`, [silo]);
      return mapComputerRows(result.rows);
    },
    close: () => pool.end(),
  };
}
