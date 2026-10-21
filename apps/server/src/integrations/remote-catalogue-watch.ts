import type { EventStore } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';
import { history, mcpCatalogueWatch, readToolPolicy } from '@opencrane/models';
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
  async function capture(serverId: string, signal: AbortSignal) {
    const rows = await history(store, `mcp-${serverId}`, silo, performance.now() + 30_000);
    function registered(row: typeof rows[number]) {
      return row.event.type === 'mcp.server_registered';
    }
    const saved = rows.findLast(registered);
    const source = registration.parse(saved?.event.data);
    const policy = await readToolPolicy(store, silo, serverId, performance.now() + 30_000);
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

  async function reconcile() {
    let serverIds: string[];
    try {
      await requireLeader();
      const result = await db.query(`SELECT silo, server_id, source_kind FROM mcp_catalogue
        WHERE silo = $1 AND source_kind = 'remote' AND tool_count IS NOT NULL
        ORDER BY server_id LIMIT 32`, [silo]);
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
      watch.reconcile(serverIds);
    } catch {
      watch.reconcile([]);
      throw new Error('Catalogue rows unavailable');
    }
    return serverIds;
  }
  function checkServers(serverIds: string[]) {
    const checks = serverIds.map(watch.checkDue);
    return Promise.all(checks);
  }
  function finished() {
    active = undefined;
    nextRead = Date.now() + 1000;
  }
  function check() {
    if (stopped) {
      return Promise.reject(new Error('Catalogue watch stopped'));
    }
    if (!active) {
      const reading = reconcile();
      active = reading.finally(finished);
    }
    return active.then(checkServers);
  }
  function tick(onError: (error: unknown) => void) {
    if (!stopped && !active && Date.now() >= nextRead) {
      void check().catch(onError);
    }
  }
  function close() {
    stopped = true;
    watch.close();
  }
  return { check, tick, requireCurrent: watch.requireCurrent, close };
}
