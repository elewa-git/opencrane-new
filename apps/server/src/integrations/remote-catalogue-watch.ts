import type { EventStore } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';
import { history, mcpCatalogueWatch, toolPolicyFromRows } from '@opencrane/models';
import { z } from 'zod';
import { discoverInventory } from './inventory.ts';
import { remoteRequest, type RemoteNetwork } from './remote.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const candidate = z.object({ silo: z.string(), server_id: identifier,
  source_kind: z.literal('remote') });
const registration = z.object({ serverId: identifier, kind: z.literal('remote'),
  locator: z.string() });

export function remoteCatalogueWatch(db: Query, store: EventStore, silo: string,
  requireLeader: () => Promise<void>, network: RemoteNetwork = {}) {
  let stopped = false;
  let active: Promise<string[]> | undefined;
  let nextRead = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportError: ((error: unknown) => void) | undefined;
  async function capture(serverId: string, signal: AbortSignal) {
    const rows = await history(store, `mcp-${serverId}`, silo, performance.now() + 30_000);
    function registered(row: typeof rows[number]) {
      return row.event.type === 'mcp.server_registered';
    }
    const saved = rows.findLast(registered);
    const source = registration.parse(saved?.event.data);
    const policy = toolPolicyFromRows(rows);
    if (source.serverId !== serverId || policy.accountMode !== 'none' || !policy.connectionId) {
      throw new Error('Remote catalogue unavailable');
    }
    async function call(method: 'server/discover' | 'tools/list', cursor?: string) {
      signal.throwIfAborted();
      const reply = await remoteRequest(source.locator, method, cursor, network, signal);
      return reply.resultJson;
    }
    const inventory = await discoverInventory(call);
    return { ...inventory, serverId, connectionId: policy.connectionId, accountMode: 'none' as const };
  }
  const options = { serverIds: [], capture, requireLeader };
  const watch = mcpCatalogueWatch(store, silo, options);

  async function readRows() {
    const timeout = Promise.withResolvers<never>();
    let expired = false;
    function expire() {
      expired = true;
      timeout.reject(new Error('Catalogue rows unavailable'));
    }
    async function read() {
      await requireLeader();
      if (expired || stopped) {
        throw new Error('Catalogue rows unavailable');
      }
      return db.query(`SELECT silo, server_id, source_kind FROM mcp_catalogue
        WHERE silo = $1 AND source_kind = 'remote' AND tool_count IS NOT NULL
        ORDER BY server_id LIMIT 32`, [silo]);
    }
    const deadline = setTimeout(expire, 1000);
    try {
      // Ignore a late query result so it cannot restore membership after a timeout.
      const reading = read();
      const results = [reading, timeout.promise];
      return await Promise.race(results);
    } finally {
      clearTimeout(deadline);
    }
  }

  async function reconcile() {
    let serverIds: string[];
    try {
      const result = await readRows();
      if (stopped) {
        throw new Error('Catalogue rows unavailable');
      }
      serverIds = [];
      for (const raw of result.rows) {
        const row = candidate.parse(raw);
        if (row.silo !== silo) {
          throw new Error('Catalogue silo mismatch');
        }
        serverIds.push(row.server_id);
      }
    } catch {
      await watch.reconcile([]);
      throw new Error('Catalogue rows unavailable');
    }
    await watch.reconcile(serverIds);
    return serverIds;
  }
  function checkServer(serverId: string) {
    const checking = watch.checkDue(serverId);
    // Re-arm healthy servers even if another capture has already rejected the batch.
    return checking.finally(schedule);
  }
  function checkServers(serverIds: string[]) {
    const checks = serverIds.map(checkServer);
    return Promise.all(checks);
  }
  function finished() {
    active = undefined;
    nextRead = Date.now() + 1000;
    schedule();
  }
  function check() {
    if (stopped) {
      return Promise.reject(new Error('Catalogue watch stopped'));
    }
    if (!active) {
      const reading = reconcile();
      active = reading.finally(finished);
    }
    const checking = active.then(checkServers);
    return checking.finally(schedule);
  }
  function tick(onError: (error: unknown) => void) {
    reportError = onError;
    const next = Math.min(nextRead, watch.nextCheckAt());
    if (!stopped && !active && Date.now() >= next) {
      void check().catch(onError);
    }
    schedule();
  }
  function poll() {
    if (reportError) {
      tick(reportError);
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (stopped || active || !reportError) {
      return;
    }
    // Wake for short catalogue TTLs even while the models loop is doing other work.
    const next = Math.min(nextRead, watch.nextCheckAt());
    const delayMs = Math.max(1, next - Date.now());
    timer = setTimeout(poll, delayMs);
  }
  function close() {
    stopped = true;
    clearTimeout(timer);
    watch.close();
  }
  return { check, tick, requireCurrent: watch.requireCurrent, close };
}
