import { body, catalogue, permit, send, publishedFixture } from './support/mcp-dispatch-fixture.ts';
import { remoteFixture } from './support/remote-mcp.ts';
import { writeFile } from 'node:fs/promises';
import { envelope } from '../src/actor.ts';
import { recordAdapterObservation, recordToolObservation, toolObservation }
  from '../src/tool-dispatch.ts';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { expect, it, onTestFinished, vi } from 'vitest';
import { history, ingestUsage } from '../src/index.ts';
import { fixture } from './fixture.ts';
import { gatewayCall } from './support/mcp-dispatch-assertions.ts';

const remoteGuards = ['gateway', 'bytes', 'private', 'metadata', 'mixed', 'empty', 'rebind',
  'untrusted', 'wrong_name', 'redirect', 'oversize', 'session', 'mime', 'reply_fields',
  'undeclared', 'revision', 'dns_timeout', 'permit_timeout', 'held_start', 'lost_start',
  'deadline', 'watch_admission', 'watch_final'] as const;

function restoreTlsIdentityClock() {
  vi.restoreAllMocks();
}

function holdTlsIdentityClock() {
  // Reach certificate verification without making this case a test of dispatch expiry.
  const elapsed = performance.now();
  const wall = Date.now();
  const elapsedClock = vi.spyOn(performance, 'now');
  elapsedClock.mockReturnValue(elapsed);
  const wallClock = vi.spyOn(Date, 'now');
  wallClock.mockReturnValue(wall);
  onTestFinished(restoreTlsIdentityClock);
}

async function guardsRemoteCall(mode: typeof remoteGuards[number]) {
  const raw = body.replace('"arguments":{', '"arguments":{"number":1.0e3,');
  const context = await publishedFixture('allow', true, mode !== 'undeclared');
  const { setup } = context;
  const remote = await remoteFixture(mode === 'wrong_name');
  onTestFinished(remote.close);
  setup.dispatchOptions.routes.length = 0;
  Object.assign(setup.dispatchOptions, { remoteNetwork: remote.network });
  let held = mode === 'watch_admission';
  function requireCatalogue() {
    if (held) throw new Error('Catalogue watch unavailable');
  }
  setup.dispatchOptions.requireCatalogue = requireCatalogue;
  remote.revision(catalogue.schemaDigest);
  if (mode === 'private') remote.setAnswers(['127.0.0.1']);
  if (mode === 'metadata') remote.setAnswers(['169.254.169.254']);
  if (mode === 'mixed') remote.setAnswers(['93.184.216.34', '127.0.0.1']);
  function emptyDns() { return Promise.resolve([]); }
  if (mode === 'empty') remote.network.resolve = emptyDns;
  if (mode === 'rebind') remote.rebind();
  if (mode === 'untrusted') remote.untrust();
  if (mode === 'redirect') remote.status(307);
  function largeReply() { return 'x'.repeat(1024 * 1024 + 1); }
  if (mode === 'oversize') remote.respond(largeReply);
  if (mode === 'mime') remote.replyFields({ 'content-type': 'text/plain' });
  if (mode === 'session') remote.replyFields({ 'mcp-session-id': 'REPLY_CANARY' });
  if (mode === 'reply_fields') remote.replyFields({ 'set-cookie': 'REPLY_CANARY' });
  if (mode === 'revision') remote.revision('a'.repeat(64));
  const releaseDns = Promise.withResolvers<{ address: string; family: number }[]>();
  if (mode === 'dns_timeout' || mode === 'permit_timeout') {
    function heldDns() { return releaseDns.promise; }
    remote.network.resolve = heldDns;
  }
  const rowsBefore = await setup.nats.store.head();
  if (mode === 'wrong_name' || mode === 'untrusted') holdTlsIdentityClock();
  if (mode === 'undeclared' || mode === 'watch_admission') {
    expect(await gatewayCall(context)).toBe(403);
    expect(remote.dnsCalls()).toBe(0);
  } else if (mode === 'gateway') {
    expect(await gatewayCall(context, {}, raw)).toBe(200);
    expect(remote.received[0]!.raw.toString()).toContain('"number":1.0e3');
    expect(remote.received[0]!.raw.toString()).not.toContain('x-codex-turn-metadata');
  } else {
    const headers = { ...context.headers, ...context.constants };
    const value = await permit(setup, headers, raw);
    const append = setup.nats.store.append.bind(setup.nats.store);
    const startSaved = Promise.withResolvers<void>();
    const releaseStart = Promise.withResolvers<void>();
    async function holdStart(command: AppendCommand) {
      const result = await append(command);
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'tool.dispatch_started') {
        startSaved.resolve();
        if (mode === 'watch_final') held = true;
        if (mode === 'lost_start') throw new Error('Save reply lost');
        if (mode === 'held_start') await releaseStart.promise;
      }
      return result;
    }
    const writer = vi.spyOn(setup.nats.store, 'append').mockImplementation(holdStart);
    const timer = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    function captureDeadline(callback: (...args: unknown[]) => void, delay?: number,
      ...args: unknown[]) {
      if (delay === 30_000) {
        expire = callback;
        return timer(function heldDeadline() {}, 60_000);
      }
      return timer(callback, delay, ...args);
    }
    function noReply() { return undefined; }
    if (mode === 'deadline') {
      remote.respond(noReply);
      const replacement = Object.assign(captureDeadline, timer);
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(replacement);
    }
    if (mode === 'permit_timeout') await pause(1500);
    const canaries = { host: 'caller.example.test', authorization: 'CANARY',
      'x-turn-token': 'CANARY', cookie: 'CANARY', 'session-id': 'CANARY',
      'mcp-session-id': 'CANARY', 'x-forwarded-for': 'CANARY', 'x-memory-context': 'CANARY',
      'x-opencrane-mcp-permit': value };
    const request = { method: 'POST', headers: canaries, body: raw };
    const beforeSend = performance.now();
    if (mode === 'wrong_name') holdTlsIdentityClock();
    const sending = fetch(`${setup.options.decisionUrl}/dispatch/mcp/fixture/installed`, request);
    try {
      if (mode === 'held_start') {
        await startSaved.promise;
        await pause(50);
        expect(remote.connections()).toBe(0);
        releaseStart.resolve();
      }
      if (mode === 'deadline') {
        function received() { return remote.received.length; }
        await expect.poll(received).toBe(1);
        expect(expire).toBeDefined();
        expire!();
      }
      const response = await sending;
      const success = ['bytes', 'rebind', 'reply_fields', 'held_start'].includes(mode);
      let expected = success ? 200 : 502;
      if (['private', 'metadata', 'mixed', 'empty', 'dns_timeout', 'permit_timeout',
        'lost_start', 'watch_final'].includes(mode)) expected = 403;
      if (mode === 'deadline') expected = 504;
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(expected);
      if (mode === 'wrong_name' || mode === 'untrusted') {
        expect(responseBody).toBe('');
        expect(remote.pooling).toEqual([false]);
      }
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('mcp-session-id')).toBeNull();
      if (mode === 'dns_timeout') expect(performance.now() - beforeSend).toBeLessThan(1300);
      if (mode === 'permit_timeout') expect(performance.now() - beforeSend).toBeLessThan(700);
      if (success || ['redirect', 'oversize', 'session', 'mime', 'revision', 'deadline'].includes(mode)) {
        expect(remote.received).toHaveLength(1);
        expect(remote.received[0]!.raw.toString()).toContain('"number":1.0e3');
        expect(remote.received[0]!.raw.toString()).not.toContain('x-codex-turn-metadata');
        expect(remote.received[0]!.hostname).toBe('mcp.example.test');
        expect(remote.received[0]!.headers).toEqual({ host: 'mcp.example.test',
          'content-type': 'application/json', accept: 'application/json',
          'content-length': String(remote.received[0]!.raw.length),
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call', 'mcp-name': 'write',
          'x-opencrane-mcp-revision': catalogue.schemaDigest });
        expect(remote.dnsCalls()).toBe(1);
        expect(remote.pinned).toEqual(['93.184.216.34']);
        expect(remote.pooling).toEqual([false]);
      } else {
        expect(remote.received).toHaveLength(0);
      }
    } finally {
      releaseStart.resolve();
      releaseDns.resolve([{ address: '93.184.216.34', family: 4 }]);
      writer.mockRestore();
      vi.restoreAllMocks();
    }
  }
  const rows: StoredEvent[] = [];
  const last = await setup.nats.store.head();
  for (let position = rowsBefore + 1; position <= last; position++) {
    rows.push(await setup.nats.store.readEvent(position));
  }
  const encoded = JSON.stringify(rows);
  if (mode === 'watch_final') {
    function recorded(row: StoredEvent) {
      return row.event.type === 'tool.dispatch_recorded';
    }
    const observations = rows.filter(recorded);
    expect(observations).toHaveLength(1);
    const expectedRefusal = { outcome: 'not_dispatched',
      evidence: 'adapter_dispatch_refused',
      adapter: { connectionId: 'installed', generation: context.record.generation } };
    expect(observations[0]!.event.data).toMatchObject(expectedRefusal);
  } else {
    expect(encoded).not.toContain('not_dispatched');
  }
  if (['lost_start', 'watch_final'].includes(mode)) expect(remote.connections()).toBe(0);
  if (['redirect', 'untrusted', 'wrong_name', 'lost_start', 'watch_final'].includes(mode)) {
    expect(encoded).toContain('tool.dispatch_started');
  }
  if (['private', 'metadata', 'mixed', 'empty', 'undeclared', 'dns_timeout',
    'permit_timeout', 'watch_admission'].includes(mode)) {
    expect(remote.connections()).toBe(0);
    expect(encoded).not.toContain('tool.dispatch_started');
    expect(encoded).not.toContain('mcp.dispatch_admitted');
  }
  expect(setup.received()).toBe(0);
}

it.each(remoteGuards)('guards published HTTPS tool calls: %s', guardsRemoteCall);

async function remoteOutcomeFixture() {
  const context = await publishedFixture('allow', true);
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  context.setup.dispatchOptions.routes.length = 0;
  context.setup.dispatchOptions.remoteNetwork = remote.network;
  remote.revision(catalogue.schemaDigest);
  const headers = { ...context.headers, ...context.constants };
  const value = await permit(context.setup, headers);
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  const { requestId } = z.object({ requestId: z.uuid() }).parse(decoded);
  const subject = `decision-${requestId}`;
  return { ...context, remote, value, requestId, subject };
}

async function adapterRecorderFixture() {
  const context = await remoteOutcomeFixture();
  const { setup, requestId, subject, record } = context;
  const decisions = await history(setup.nats.store, subject, 'test');
  const startId = `${requestId}:tool-dispatch-started`;
  const binding = {
    silo: 'test',
    decisionId: decisions[0]!.event.id,
    startId,
    connectionId: 'installed',
    generation: record.generation,
    recordDigest: record.recordDigest,
    reviewRevision: record.members[0]!.entry.reviewRevision,
  };
  const startData = {
    requestId,
    serverId: 'fixture',
    connectionId: binding.connectionId,
    generation: binding.generation,
    recordDigest: binding.recordDigest,
    reviewRevision: binding.reviewRevision,
    adapter: 'remote_https',
  };
  const start = envelope('test', subject, 'tool.dispatch_started', startData, startId);
  // Seed a saved start so callbacks can be tested without sending an HTTP request.
  const events = [start];
  await setup.nats.seed(events);
  const observation = {
    id: requestId,
    toolOutcome: 'responded' as const,
    evidence: 'adapter_response_received' as const,
    observedAt: new Date().toISOString(),
    durationMs: 1,
  };
  return { ...context, binding, observation };
}

async function repeatsIdenticalAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  await recordAdapterObservation(setup.actor, binding, observation);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  const writer = vi.spyOn(setup.nats.store, 'append');
  try {
    await recordAdapterObservation(setup.actor, binding, observation);
    expect(writer).not.toHaveBeenCalled();
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    expect(remote.received).toHaveLength(0);
    expect(remote.connections()).toBe(0);
    expect(setup.received()).toBe(0);
  } finally {
    writer.mockRestore();
  }
}

it('adds nothing for an identical direct adapter callback', repeatsIdenticalAdapterCallback);

async function checksRepeatedAdapterCost(change: 'identical' | 'amount' | 'status') {
  const { setup, subject, binding, observation } = await adapterRecorderFixture();
  const reported = { ...observation, costStatus: 'reported' as const, costCents: 7 };
  await recordAdapterObservation(setup.actor, binding, reported);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  expect(rows[2]!.event.data).toMatchObject({ costStatus: 'reported', costCents: 7 });
  let repeated = reported;
  if (change === 'amount') repeated = { ...reported, costCents: 99 };
  const invalid = { ...observation, costStatus: 'invalid' as const };
  const callback = change === 'status' ? invalid : repeated;
  const repeatedBinding = { reviewRevision: binding.reviewRevision,
    recordDigest: binding.recordDigest, generation: binding.generation,
    connectionId: binding.connectionId, startId: binding.startId,
    decisionId: binding.decisionId, silo: binding.silo };
  const recording = recordAdapterObservation(setup.actor, repeatedBinding, callback);
  if (change === 'identical') {
    await recording;
  } else {
    await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
  }
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
}

it.each(['identical', 'amount', 'status'] as const)(
  'checks repeated adapter cost by fields: %s', checksRepeatedAdapterCost);

async function refusesForeignAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  const foreignBinding = { ...binding, silo: 'other' };
  const recording = recordAdapterObservation(setup.actor, foreignBinding, observation);
  await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}

it('refuses a direct adapter callback from a foreign silo', refusesForeignAdapterCallback);

async function refusesChangedAdapterCallback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const uncertain = {
    ...observation,
    toolOutcome: 'outcome_unknown' as const,
    evidence: 'adapter_transport_uncertain' as const,
  };
  await recordAdapterObservation(setup.actor, binding, uncertain);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  expect(rows[2]!.event.data).toMatchObject({
    outcome: 'outcome_unknown',
    evidence: 'adapter_transport_uncertain',
  });
  const recording = recordAdapterObservation(setup.actor, binding, observation);
  await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}

it('refuses a direct responded callback after a saved unknown outcome', refusesChangedAdapterCallback);

async function refusesConflictingAdapterReadback() {
  const { setup, remote, subject, binding, observation } = await adapterRecorderFixture();
  const uncertain = {
    ...observation,
    toolOutcome: 'outcome_unknown' as const,
    evidence: 'adapter_transport_uncertain' as const,
  };
  await recordAdapterObservation(setup.actor, binding, uncertain);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  let reads = 0;
  async function* staleFirstRead(...args: Parameters<typeof readStream>) {
    if (args[0] === subject) reads += 1;
    for await (const row of readStream(...args)) {
      // Model an initial read that finished before another callback saved its outcome.
      if (args[0] === subject && reads === 1 && row.event.type === 'tool.dispatch_recorded') {
        continue;
      }
      yield row;
    }
  }
  function lostSaveReply(): Promise<never> {
    const error = new Error('Save reply lost');
    return Promise.reject(error);
  }
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  const writer = vi.spyOn(setup.nats.store, 'append');
  reader.mockImplementation(staleFirstRead);
  writer.mockImplementation(lostSaveReply);
  try {
    const recording = recordAdapterObservation(setup.actor, binding, observation);
    await expect(recording).rejects.toThrow('Tool dispatch evidence unavailable');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
  } finally {
    reader.mockRestore();
    writer.mockRestore();
  }
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(0);
  expect(remote.connections()).toBe(0);
  expect(setup.received()).toBe(0);
}

it('refuses conflicting saved evidence on direct adapter callback readback',
  refusesConflictingAdapterReadback);

async function savesRemoteResponse(mode: 'result' | 'tool_error' | 'rpc_error') {
  const { setup, remote, value, requestId, subject, record } = await remoteOutcomeFixture();
  function toolError() { return { isError: true, content: [] }; }
  function rpcError() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{"code":-32603,"message":"REPLY_CANARY"}}';
  }
  if (mode === 'tool_error') remote.respond(toolError);
  if (mode === 'rpc_error') remote.respond(rpcError);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(3);
  expect(rows[2]!.event).toMatchObject({ type: 'tool.dispatch_recorded', silo: 'test',
    data: { requestId, outcome: 'responded', evidence: 'adapter_response_received',
      adapter: { decisionId: rows[0]!.event.id, startId: rows[1]!.event.id,
        connectionId: 'installed', generation: record.generation,
        recordDigest: record.recordDigest, reviewRevision: record.members[0]!.entry.reviewRevision } } });
  expect((await send(setup, value)).status).toBe(403);
  expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  expect(remote.received).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/REPLY_CANARY|mcp.example.test/u);
}

it.each(['result', 'tool_error', 'rpc_error'] as const)(
  'saves a checked remote response against its consumed permit once: %s', savesRemoteResponse);

const remoteFailures = ['reset', 'timeout', 'redirect', 'invalid_json', 'wrong_id',
  'duplicate_key', 'invalid_error', 'gateway_502', 'gateway_refused'] as const;

async function keepsRemoteFailureUnknown(mode: typeof remoteFailures[number]) {
  const context = await remoteOutcomeFixture();
  const { setup, remote, value, requestId, subject } = context;
  function invalidReply() { return 'INVALID_REPLY_CANARY'; }
  function wrongId() { return '{"jsonrpc":"2.0","id":"other","result":{}}'; }
  function invalidError() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"error":{}}';
  }
  function duplicateKey() {
    return '{"jsonrpc":"2.0","id":REQUEST_ID,"result":{},"result":{}}';
  }
  function noReply() { return undefined; }
  if (mode === 'reset') remote.reset();
  if (mode === 'redirect') remote.status(307);
  if (mode === 'invalid_json') remote.respond(invalidReply);
  if (mode === 'wrong_id') remote.respond(wrongId);
  if (mode === 'duplicate_key') remote.respond(duplicateKey);
  if (mode === 'invalid_error') remote.respond(invalidError);
  if (mode.startsWith('gateway_')) remote.status(502);
  const timer = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  function captureDeadline(callback: (...args: unknown[]) => void, delay?: number,
    ...args: unknown[]) {
    if (delay === 30_000) {
      expire = callback;
      return timer(function heldDeadline() {}, 60_000);
    }
    return timer(callback, delay, ...args);
  }
  if (mode === 'timeout') {
    remote.respond(noReply);
    const replacement = Object.assign(captureDeadline, timer);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    timerSpy.mockImplementation(replacement);
  }
  const append = setup.nats.store.append.bind(setup.nats.store);
  let gatewayRecorded = false;
  async function gatewayFirst(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_recorded' && mode.startsWith('gateway_') && !gatewayRecorded) {
      gatewayRecorded = true;
      let suffix = 'http.status=502';
      if (mode === 'gateway_refused') {
        suffix = 'error="upstream call failed: Connect: Connection refused (os error 111)"';
      }
      const line = `${new Date().toISOString()} route=default/mcp-fixture ` +
        `toolRequestId="${requestId}" duration=1ms ${suffix}`;
      await recordToolObservation(setup.actor, toolObservation(line)!);
    }
    return append(command);
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(gatewayFirst);
  try {
    const sending = send(setup, value);
    if (mode === 'timeout') {
      function received() { return remote.received.length; }
      await expect.poll(received).toBe(1);
      expect(expire).toBeDefined();
      expire!();
    }
    const response = await sending;
    expect(response.status).toBe(mode === 'timeout' ? 504 : 502);
    expect(await response.text()).toBe('');
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(3);
    expect(rows[2]!.event.data).toMatchObject({ outcome: 'outcome_unknown',
      evidence: 'adapter_transport_uncertain' });
    const success = { id: requestId, toolOutcome: 'responded' as const,
      evidence: 'response_received' as const, observedAt: new Date().toISOString(), durationMs: 1 };
    await recordToolObservation(setup.actor, success);
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    expect(JSON.stringify(rows)).not.toMatch(/not_dispatched|INVALID_REPLY_CANARY|mcp.example.test/u);
    expect((await send(setup, value)).status).toBe(403);
    expect(remote.received).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
  }
}

it.each(remoteFailures)('keeps remote adapter failure unknown: %s', keepsRemoteFailureUnknown);

const remoteSaveFailures = ['lost_reply', 'outage', 'lost_start', 'decision', 'silo',
  'start', 'generation', 'forged'] as const;

async function checksRemoteEvidence(mode: typeof remoteSaveFailures[number]) {
  const { setup, remote, value, requestId, subject } = await remoteOutcomeFixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  async function save(command: AppendCommand) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'tool.dispatch_recorded' && mode === 'outage') {
      throw new Error('Store unavailable');
    }
    const result = await append(command);
    if ((event.type === 'tool.dispatch_recorded' && mode === 'lost_reply') ||
        (event.type === 'tool.dispatch_started' && mode === 'lost_start')) {
      throw new Error('Save reply lost');
    }
    return result;
  }
  async function* changedHistory(...args: Parameters<typeof readStream>) {
    for await (const row of readStream(...args)) {
      const copy = structuredClone(row);
      if (args[0] === subject && remote.received.length > 0) {
        if (mode === 'silo') copy.event.silo = 'other';
        if (mode === 'decision' && copy.event.type === 'decision.recorded') {
          copy.event.id = 'foreign-decision';
        }
        if (copy.event.type === 'tool.dispatch_started') {
          if (mode === 'start') copy.event.id = 'foreign-start';
          if (mode === 'generation') {
            const data = z.record(z.string(), z.unknown()).parse(copy.event.data);
            copy.event.data = { ...data, generation: 99 };
          }
        }
      }
      yield copy;
    }
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  const reader = vi.spyOn(setup.nats.store, 'readStream');
  writer.mockImplementation(save);
  reader.mockImplementation(changedHistory);
  try {
    if (mode === 'forged') {
      const forged = { id: requestId, toolOutcome: 'responded',
        evidence: 'adapter_response_received', observedAt: new Date().toISOString(), durationMs: 0 };
      await writeFile(setup.options.usageFile, `${JSON.stringify(forged)}\n`);
      await expect(ingestUsage(setup.actor, setup.options.usageFile)).rejects.toThrow();
      expect(await history(setup.nats.store, subject, 'test')).toHaveLength(1);
    }
    const response = await send(setup, value);
    let expected = 503;
    if (mode === 'lost_reply' || mode === 'forged') expected = 200;
    if (mode === 'lost_start') expected = 403;
    expect(response.status).toBe(expected);
    writer.mockRestore();
    reader.mockRestore();
    const rows = await history(setup.nats.store, subject, 'test');
    expect(rows).toHaveLength(expected === 200 ? 3 : 2);
    expect(JSON.stringify(rows)).not.toContain('not_dispatched');
    if (mode === 'lost_start') {
      expect(remote.connections()).toBe(0);
      const generic = { id: requestId, toolOutcome: 'not_dispatched' as const,
        evidence: 'connection_refused' as const, observedAt: new Date().toISOString(), durationMs: 0 };
      await recordToolObservation(setup.actor, generic);
      expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
    }
    const before = remote.received.length;
    await setup.restartActor();
    expect((await send(setup, value)).status).toBe(403);
    expect(remote.received).toHaveLength(before);
    expect(await history(setup.nats.store, subject, 'test')).toEqual(rows);
  } finally {
    vi.restoreAllMocks();
  }
}

it.each(remoteSaveFailures)('checks remote adapter evidence without resending: %s', checksRemoteEvidence);

async function keepsGenericEvidence(serverId: string, refused: boolean) {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const requestId = '00000000-0000-4000-8000-000000000001';
  const subject = `decision-${requestId}`;
  const decision = { requestId, route: 'mcp', outcome: 'allow', reason: 'allowed',
    contextDigest: 'a'.repeat(64), logicalRequestId: 'b'.repeat(64),
    conversationId: 'conversation', turnId: 'dispatch', callId: 'call', serverId, toolName: 'write' };
  await setup.append(subject, 'decision.recorded', decision);
  const observation = { id: requestId, observedAt: new Date().toISOString(), durationMs: 1,
    toolOutcome: refused ? 'not_dispatched' as const : 'responded' as const,
    evidence: refused ? 'connection_refused' as const : 'response_received' as const };
  await recordToolObservation(setup.actor, observation);
  const rows = await history(setup.nats.store, subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.event.data).toMatchObject({ outcome: observation.toolOutcome,
    evidence: observation.evidence });
  expect(rows[1]!.event.data).not.toHaveProperty('adapter');
}

it.each([['fixture', false], ['fixture', true], ['memory', false], ['memory', true]] as const)(
  'keeps generic gateway evidence for %s (refused %s)', keepsGenericEvidence);
