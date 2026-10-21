import type { EventStore } from '@opencrane/event-store';
import { losslessJson, type JsonValue } from '@opencrane/events/lossless-json';
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

  function reconcile(serverIds: string[]) {
    const wanted = new Set(serverIds.slice(0, 32));
    for (const [serverId, state] of servers) {
      if (wanted.has(serverId)) {
        continue;
      }
      state.monitored = false;
      holdWatch(state);
      state.controller?.abort();
      // Keep unfinished captures and unsaved drift holds within the same bounded set.
      if (!state.active && !state.driftHeld) {
        servers.delete(serverId);
      }
    }
    for (const serverId of wanted) {
      const state = servers.get(serverId);
      if (state) {
        state.monitored = true;
      } else if (servers.size < 32) {
        servers.set(serverId, newWatch());
      }
    }
  }

  function checkDue(serverId: string) {
    const state = servers.get(serverId);
    if (!state || !state.monitored || state.active || state.failures >= 3 ||
        Date.now() < state.nextCheck) {
      return Promise.resolve();
    }
    return check(serverId);
  }

  function nextCheckAt() {
    let next = Infinity;
    for (const state of servers.values()) {
      if (state.monitored && !state.active && state.failures < 3) {
        next = Math.min(next, state.nextCheck);
      }
    }
    return next;
  }

  function requireCurrent(serverId: string) {
    const state = servers.get(serverId);
    if (state && state.expiresAt <= Date.now()) {
      holdWatch(state);
    }
    if (stopped || !state || !state.monitored || state.held || state.driftHeld ||
        state.expiresAt <= Date.now()) {
      throw new Error('MCP catalogue watch unavailable');
    }
  }

  function check(serverId: string): Promise<void> {
    const found = servers.get(serverId);
    if (stopped || !found || !found.monitored) {
      return Promise.reject(new Error('Catalogue watch stopped'));
    }
    const state = found;
    if (state.active) return state.active;
    const controller = new AbortController();
    state.controller = controller;
    function expire() {
      holdWatch(state);
      controller.abort(new Error('Catalogue watch timeout'));
    }
    const timer = setTimeout(expire, 30_000);
    async function run() {
      try {
        const refreshing = refresh(serverId, state, controller.signal);
        await untilAborted(refreshing, controller.signal);
        state.failures = 0;
        state.nextCheck = refreshAt(state);
      } catch (error) {
        holdWatch(state);
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
    let invalidated = state.held;
    if (invalidated) {
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
    const currentContract = revisionContract(catalogue.discoverResult);
    const savedContract = revisionContract(policy.catalogue.discoverResult);
    // Save withdrawn or changed dispatch promises even when every tool is identical.
    const changed = catalogue.schemaDigest !== policy.catalogue.schemaDigest ||
      currentContract !== savedContract;
    let type = 'mcp.catalogue_checked';
    let data: unknown = { serverId, outcome: 'unchanged', schemaDigest: catalogue.schemaDigest,
      checkedAt: catalogue.checkedAt, expiresAt: catalogue.expiresAt };
    if (changed) {
      // Close dispatch before trying the append. An unavailable event store must not reopen it.
      holdWatch(state);
      state.driftHeld = true;
      // Require a confirmed drift append before a later receipt can release this hold.
      state.driftSequence = Infinity;
      type = 'mcp.tools_changed';
      data = { serverId, previousSchemaDigest: policy.catalogue.schemaDigest,
        newSchemaDigest: catalogue.schemaDigest, catalogue };
    }
    await options.requireLeader();
    signal.throwIfAborted();
    async function saveCapture(sequence: number) {
      signal.throwIfAborted();
      const event = envelope(silo, `mcp-${serverId}`, type, data);
      // Reuse the policy history already read. Give each capture a new event id.
      const command = { event, expectedSequence: sequence, deadline, signal,
        historyChecked: true as const };
      const result = await store.append(command);
      if (result.status !== 'appended') throw new Error('Catalogue append unconfirmed');
      if (changed) {
        state.driftSequence = result.sequence;
      }
      signal.throwIfAborted();
    }
    await saveCapture(policy.sequence);
    // Check after the append too: evidence can expire while the event store replies.
    // Keep dispatch closed until the saved revision has invalidated old approvals.
    if (expiryNeedsFailure(state, invalidated, changed)) {
      holdWatch(state);
      await saveFailure(serverId, signal);
      policy = await readToolPolicy(store, silo, serverId, deadline);
      await options.requireLeader();
      await saveCapture(policy.sequence);
      invalidated = true;
    }
    const holdCount = state.holdCount;
    policy = await readToolPolicy(store, silo, serverId, deadline);
    signal.throwIfAborted();
    const expired = expiryNeedsFailure(state, invalidated, changed);
    // Keep any hold raised during the read, even when recovery began held.
    // Let the failure path save approval invalidation before a later check can reopen calls.
    if (expired || state.holdCount !== holdCount) {
      throw new Error('Catalogue watch changed during policy read');
    }
    refreshWatchState(state, policy, catalogue);
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

  function close() {
    stopped = true;
    for (const state of servers.values()) {
      holdWatch(state);
      state.controller?.abort();
    }
  }
  return { check, checkDue, nextCheckAt, reconcile, requireCurrent, close };
}

function refreshWatchState(state: ReturnType<typeof newWatch>,
  policy: Awaited<ReturnType<typeof readToolPolicy>>, catalogue: Catalogue) {
  state.expiresAt = Date.parse(catalogue.expiresAt!);
  state.checkedAt = Date.parse(catalogue.checkedAt!);
  const receipt = policy.configurationObservation;
  if (policy.driftHeld === true) {
    state.driftHeld = true;
  } else if (receipt && receipt.sourceSequence > state.driftSequence && policy.published &&
      policy.catalogue?.schemaDigest === catalogue.schemaDigest) {
    state.driftHeld = false;
  }
  // Keep freshness separate from drift so refreshing a held server preserves its review.
  state.held = false;
}

function expiryNeedsFailure(state: ReturnType<typeof newWatch>,
  invalidated: boolean, changed: boolean) {
  return !invalidated && !changed && state.expiresAt <= Date.now();
}

function holdWatch(state: ReturnType<typeof newWatch>) {
  state.held = true;
  state.holdCount += 1;
}

function newWatch() {
  return { monitored: true, held: true, holdCount: 0, driftHeld: false, driftSequence: 0,
    checkedAt: 0, expiresAt: 0, nextCheck: 0, failures: 0,
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

function refreshAt(state: ReturnType<typeof newWatch>) {
  const ttlMs = state.expiresAt - state.checkedAt;
  if (ttlMs <= 0) {
    return Date.now() + 1000;
  }
  // Leave most of a short TTL for reading and saving the next capture.
  // Keep the existing margin for longer TTLs.
  const marginMs = Math.min(30_000, ttlMs * 3 / 4);
  return Math.max(Date.now() + 1, state.expiresAt - marginMs);
}

function revisionContract(discovery: string | undefined) {
  if (discovery === undefined) {
    return undefined;
  }
  const parsed = losslessJson(discovery);
  const capabilities = objectField(parsed, 'capabilities');
  const experimental = objectField(capabilities, 'experimental');
  const contract = objectField(experimental, 'io.opencrane/expectedRevision');
  return contract?.canonical;
}

function objectField(value: JsonValue | undefined, name: string) {
  if (value?.value instanceof Map) {
    return value.value.get(name);
  }
  return undefined;
}
