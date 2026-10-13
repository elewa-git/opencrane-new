import type { EventStore } from '@opencrane/event-store';
import { validateMcpCatalogue } from '@opencrane/events/mcp-catalogue';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { envelope } from './actor.ts';
import { readToolPolicy } from './tool-policy.ts';

type Catalogue = ReturnType<typeof mcpServerDiscoveredDataSchema.parse>;
interface Options {
  serverIds: string[];
  capture: (serverId: string, signal: AbortSignal) => Promise<Catalogue>;
  requireLeader: () => Promise<void>;
}

export function mcpCatalogueWatch(store: EventStore, silo: string, options: Options) {
  const servers = new Map<string, ReturnType<typeof newWatch>>();
  if (options.serverIds.length > 32) throw new Error('Catalogue watch limit');
  for (const serverId of options.serverIds) {
    if (servers.has(serverId)) throw new Error('Duplicate catalogue watch');
    servers.set(serverId, newWatch());
  }
  let stopped = false;

  function requireCurrent(serverId: string) {
    const state = servers.get(serverId);
    if (stopped || !state || state.held || state.driftHeld || state.expiresAt <= Date.now()) {
      throw new Error('MCP catalogue watch unavailable');
    }
  }

  function check(serverId: string): Promise<void> {
    const found = servers.get(serverId);
    if (stopped || !found) return Promise.reject(new Error('Catalogue watch stopped'));
    const state = found;
    if (state.active) return state.active;
    const controller = new AbortController();
    state.controller = controller;
    function expire() {
      state.held = true;
      controller.abort(new Error('Catalogue watch timeout'));
    }
    const timer = setTimeout(expire, 30_000);
    async function run() {
      try {
        const refreshing = refresh(serverId, state, controller.signal);
        await untilAborted(refreshing, controller.signal);
        state.failures = 0;
        state.nextCheck = Math.max(Date.now() + 1000, state.expiresAt - 30_000);
      } catch (error) {
        state.held = true;
        state.failures += 1;
        state.nextCheck = Date.now() + 5000;
        // Save a failed check before any later recovery can make old approvals usable.
        if (!stopped) {
          const failureSignal = AbortSignal.timeout(2000);
          await untilAborted(saveFailure(serverId, failureSignal), failureSignal);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        controller.abort();
        state.active = undefined;
      }
    }
    state.active = run();
    return state.active;
  }

  async function refresh(serverId: string, state: ReturnType<typeof newWatch>,
    signal: AbortSignal) {
    const deadline = performance.now() + 30_000;
    await options.requireLeader();
    let policy = await readToolPolicy(store, silo, serverId, deadline);
    if (state.held) {
      signal.throwIfAborted();
      await saveFailure(serverId, signal);
      policy = await readToolPolicy(store, silo, serverId, deadline);
    }
    if (!policy.catalogue) throw new Error('Saved catalogue unavailable');
    signal.throwIfAborted();
    const captured = await options.capture(serverId, signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(captured)) > 900 * 1024) {
      throw new Error('Catalogue inventory limit');
    }
    const catalogue = mcpServerDiscoveredDataSchema.parse(captured);
    if (catalogue.serverId !== serverId || catalogue.connectionId !== policy.connectionId ||
        catalogue.accountMode !== policy.accountMode || !catalogue.checkedAt || !catalogue.expiresAt) {
      throw new Error('Captured catalogue identity mismatch');
    }
    validateMcpCatalogue(catalogue);
    const changed = catalogue.schemaDigest !== policy.catalogue.schemaDigest;
    let type = 'mcp.catalogue_checked';
    let data: unknown = { serverId, outcome: 'unchanged', schemaDigest: catalogue.schemaDigest,
      checkedAt: catalogue.checkedAt, expiresAt: catalogue.expiresAt };
    if (changed) {
      // Close dispatch before trying the append. An unavailable event store must not reopen it.
      state.held = true;
      state.driftHeld = true;
      type = 'mcp.tools_changed';
      data = { serverId, previousSchemaDigest: policy.catalogue.schemaDigest,
        newSchemaDigest: catalogue.schemaDigest, catalogue };
    }
    await options.requireLeader();
    signal.throwIfAborted();
    const event = envelope(silo, `mcp-${serverId}`, type, data);
    const command = { event, expectedSequence: policy.sequence, deadline, signal };
    const result = await store.append(command);
    if (result.status !== 'appended') throw new Error('Catalogue append unconfirmed');
    signal.throwIfAborted();
    state.expiresAt = Date.parse(catalogue.expiresAt);
    state.held = changed || policy.driftHeld === true || state.driftHeld;
  }

  async function saveFailure(serverId: string, signal?: AbortSignal) {
    const deadline = performance.now() + 2000;
    const policy = await readToolPolicy(store, silo, serverId, deadline);
    if (!policy.catalogue) throw new Error('Saved catalogue unavailable');
    await options.requireLeader();
    if (stopped) throw new Error('Catalogue watch stopped');
    signal?.throwIfAborted();
    const data = { serverId, outcome: 'failed', checkedAt: new Date().toISOString(),
      reason: 'catalogue_watch_unavailable' };
    const event = envelope(silo, `mcp-${serverId}`, 'mcp.catalogue_checked', data);
    const command = { event, expectedSequence: policy.sequence, deadline,
      ...(signal ? { signal } : {}) };
    const result = await store.append(command);
    if (result.status !== 'appended') throw new Error('Catalogue failure append unconfirmed');
  }

  function tick(onError: (error: unknown) => void) {
    for (const [serverId, state] of servers) {
      if (!stopped && !state.active && state.failures < 3 && Date.now() >= state.nextCheck) {
        void check(serverId).catch(onError);
      }
    }
  }

  function close() {
    stopped = true;
    for (const state of servers.values()) {
      state.held = true;
      state.controller?.abort();
    }
  }
  return { check, requireCurrent, tick, close };
}

function newWatch() {
  return { held: true, driftHeld: false, expiresAt: 0, nextCheck: 0, failures: 0,
    active: undefined as Promise<void> | undefined,
    controller: undefined as AbortController | undefined };
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal) {
  const aborted = Promise.withResolvers<never>();
  function refuse() {
    aborted.reject(new Error('Catalogue watch stopped or timed out'));
  }
  signal.addEventListener('abort', refuse, { once: true });
  try {
    if (signal.aborted) refuse();
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', refuse);
  }
}
