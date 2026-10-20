import { startupContractRejection } from './startup-credentials.ts';
import { discoverInventory } from './inventory.ts';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { envelope, history, losslessJson } from '@opencrane/models';
import { remoteRequest, type RemoteNetwork } from './remote.ts';

const input = z.object({ method: z.enum(['server/discover', 'tools/list']), cursor: z.string().min(1).max(4096).optional() }).strict().refine(c => c.method === 'tools/list' || c.cursor === undefined);
const reasons = new Set(['unsafe_address', 'invalid_endpoint', 'connection_required', 'redirect_refused', 'protocol_refused', 'request_limit', 'response_limit', 'network_refused', 'duplicate_tools', 'inventory_limit', 'pagination_limit']);

/** The in-process install identity is an expiring, server-scoped bearer held only by this worker. */
export function installWorker(app: FastifyInstance, store: EventStore, silo: string, network: RemoteNetwork = {}) {
  const leases = new Map<string, { serverId: string; signal: AbortSignal }>();
  void app.register((route, _options, done) => {
    route.removeContentTypeParser('application/json');
    route.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      try { losslessJson(String(body)); done(null, JSON.parse(String(body)) as unknown); } catch { done(new Error('Invalid quarantine request')); }
    });
  route.post('/internal/mcp/:serverId', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const lease = leases.get(req.headers.authorization ?? '');
    const { serverId } = z.object({ serverId: z.string() }).parse(req.params);
    if (!lease || lease.serverId !== serverId || lease.signal.aborted) return reply.code(403).send({ reason: 'install_identity_required' });
    try {
      const command = input.parse(req.body);
      const rows = await history(store, `mcp-${serverId}`, silo);
      if (rows.length !== 1 || rows[0]?.event.type !== 'mcp.server_registered') throw new Error('protocol_refused');
      const data = z.object({ kind: z.literal('remote'), locator: z.string() }).parse(rows[0].event.data);
      return await remoteRequest(data.locator, command.method, command.cursor, network, lease.signal);
    } catch (error) {
      const reason = error instanceof Error && reasons.has(error.message) ? error.message : 'protocol_refused';
      return reply.code(422).send({ reason });
    }
  });
    done();
  });
  async function discover(serverId: string) {
    const rows = await history(store, `mcp-${serverId}`, silo);
    if (rows.length !== 1 || rows[0]?.event.type !== 'mcp.server_registered') return;
    const registration = z.object({ kind: z.string() }).parse(rows[0].event.data);
    if (registration.kind === 'hosted') {
      await reviewHostedRegistration(store, silo, serverId, rows[0]);
      return;
    }
    const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
    const controller = new AbortController();
    leases.set(authorization, { serverId, signal: controller.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('discovery_timeout')); }, network.deadlineMs ?? 30_000);
      });
      const run = () => discoverInventory(async (method, cursor) => {
        const response = await app.inject({ method: 'POST', url: `/internal/mcp/${serverId}`, headers: { authorization }, payload: { method, ...(cursor ? { cursor } : {}) } });
        if (response.statusCode !== 200) throw new Error(response.json<{ reason: string }>().reason);
        return response.json<{ resultJson: string }>().resultJson;
      });
      const inventory = await Promise.race([run(), deadline]);
      // Keep the credential-free connection stable across worker retries and replay.
      const data = { serverId, ...inventory,
        connectionId: `installed-${serverId}`, accountMode: 'none' };
      const discovered = envelope(silo, `mcp-${serverId}`, 'mcp.server_discovered', data,
        `${rows[0].event.id}-discovery`);
      const result = await store.append({ event: discovered, expectedSequence: rows[0].sequence });
      if (result.status !== 'appended' && result.status !== 'conflict') throw new Error('Discovery append unavailable');
    } catch (error) {
      if (error instanceof Error && error.message === 'Discovery append unavailable') throw error;
      const reason = error instanceof Error && (reasons.has(error.message) || error.message === 'discovery_timeout') ? error.message : 'protocol_refused';
      const result = await store.append({ event: envelope(silo, `mcp-${serverId}`, 'mcp.server_rejected', { serverId, reason }, `${rows[0].event.id}-discovery`), expectedSequence: rows[0].sequence });
      if (result.status !== 'appended' && result.status !== 'conflict') throw new Error('Discovery append unavailable', { cause: error });
    } finally { clearTimeout(timer); controller.abort(); leases.delete(authorization); }
  }
  function start() {
    let active: Promise<void> | undefined;
    let stopped = false;
    // Reconcile only unfinished registrations. Rebuilding projections never runs this worker.
    const run = async () => {
      for await (const row of store.readStream('mcp-*')) {
        if (stopped) return;
        if (row.event.silo === silo && row.event.type === 'mcp.server_registered') {
          const data = z.object({ serverId: z.string(), kind: z.string() }).parse(row.event.data);
          if (data.kind === 'remote' || data.kind === 'hosted') await discover(data.serverId);
        }
      }
    };
    const timer = setInterval(() => {
      if (!active) active = run().catch(() => { app.log.error('MCP install reconciliation unavailable'); }).finally(() => { active = undefined; });
    }, 1000);
    timer.unref();
    app.addHook('onClose', async () => { stopped = true; clearInterval(timer); await active; });
  }
  return { discover, start };
}

async function reviewHostedRegistration(store: EventStore, silo: string, serverId: string,
  row: StoredEvent) {
  const registration = z.object({ locator: z.string(),
    credentialContract: z.unknown().optional(), installation: z.unknown().optional() })
    .parse(row.event.data);
  // Leave new credential-free requests checking until image admission is available.
  if (registration.installation !== undefined && registration.credentialContract === undefined) return;
  const reason = startupContractRejection(registration.locator, registration.credentialContract);
  // Leave compatible contracts for review without scheduling or releasing material.
  if (!reason) return;
  const event = envelope(silo, `mcp-${serverId}`, 'mcp.server_rejected',
    { serverId, reason }, `${row.event.id}-discovery`);
  const result = await store.append({ event, expectedSequence: row.sequence });
  if (result.status !== 'appended' && result.status !== 'conflict') {
    throw new Error('Discovery append unavailable');
  }
}
