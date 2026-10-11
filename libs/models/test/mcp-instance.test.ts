import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, mcpInstanceId } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { applyMcpInstance, mcpInstances, pgDb, ProjectionRunner } from '@opencrane/projections';
import { envelope, history, mcpInstanceCommand, mcpInstanceStatus,
  mcpInstanceChange } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const now = '2026-10-11T12:00:00.000Z';
const key = { siloId: 'test', userId: 'alice', profileId: 'profile-id', serverId: 'server-id',
  credentialGeneration: 1 };

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  for (const memberId of ['alice', 'bob']) {
    const joined = envelope('test', `member-${memberId}`, 'member.joined',
      { memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId });
    expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status)
      .toBe('appended');
    await auth.handler.handle(joined, pgDb(storage.queue));
  }
}
beforeAll(initialise, 120_000);
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);

async function start() {
  counter += 1;
  const identity = { ...key, profileId: `profile-${counter}` };
  const instanceId = mcpInstanceId(identity);
  const reference = { instanceId, profileId: identity.profileId, serverId: identity.serverId };
  const data = { ...identity, instanceId, connectionId: 'connection-id',
    imageDigest: 'a'.repeat(64), installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64),
    workloadSpecDigest: 'c'.repeat(64), runGeneration: 1, changeRef: `start-${counter}`,
    requestedAt: now, deadline: '2026-10-11T12:00:20.000Z' };
  const event = envelope('test', `mcp-instance-${instanceId}`,
    'mcp.instance_start_requested', data);
  const result = await nats.store.append({ event, expectedSequence: 0 });
  expect(result.status).toBe('appended');
  if (result.status !== 'appended') throw new Error('Start fixture failed');
  const stop = { action: 'stop', changeRef: `stop-${counter}`,
    expectedSequence: result.sequence, runGeneration: 1 };
  return { identity, reference, data, event, sequence: result.sequence, stop };
}

const foreignReferences = [
  { field: 'silo', silo: 'foreign', member: 'alice', overrides: {} },
  { field: 'user', silo: 'test', member: 'bob', overrides: {} },
  { field: 'profile', silo: 'test', member: 'alice', overrides: { profileId: 'foreign' } },
  { field: 'server', silo: 'test', member: 'alice', overrides: { serverId: 'foreign' } },
  { field: 'renamed profile label', silo: 'test', member: 'alice',
    overrides: { profileId: 'My renamed account' } },
];
async function refusesForeign(testCase: (typeof foreignReferences)[number]) {
  const fixture = await start();
  const reference = { ...fixture.reference, ...testCase.overrides };
  const callerBinding = { ...binding, silo: testCase.silo };
  await expect(mcpInstanceStatus(nats.store, callerBinding, testCase.member, reference))
    .rejects.toThrow();
  await expect(mcpInstanceCommand(nats.store, callerBinding, testCase.member,
    reference, fixture.stop)).rejects.toThrow();
  await expect(mcpInstanceChange(nats.store, callerBinding, testCase.member,
    reference, fixture.data.changeRef)).rejects.toThrow();
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it.each(foreignReferences)('refuses foreign $field for commands and reads', refusesForeign);

async function refusesStale() {
  const fixture = await start();
  for (const overrides of [{ expectedSequence: 0 }, { runGeneration: 2 }]) {
    const command = { ...fixture.stop, ...overrides };
    await expect(mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, command))
      .rejects.toThrow();
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('refuses stale revisions and runs without saving an event', refusesStale);

async function bindsOriginalPayload() {
  const fixture = await start();
  const receipt = await mcpInstanceCommand(nats.store, binding, 'alice',
    fixture.reference, fixture.stop);
  expect(receipt.status).toBe('applied');
  expect(await mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, fixture.stop))
    .toEqual(receipt);
  const changed = { ...fixture.stop, expectedSequence: receipt.sequence };
  await expect(mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, changed))
    .rejects.toThrow();
  expect(await mcpInstanceChange(nats.store, binding, 'alice', fixture.reference,
    fixture.stop.changeRef)).toEqual(receipt);
  const original = await mcpInstanceChange(nats.store, binding, 'alice', fixture.reference,
    fixture.data.changeRef);
  expect(original).toMatchObject({ status: 'applied', operation: 'mcp.instance_start_requested',
    sequence: fixture.sequence, runGeneration: 1 });
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(2);
}
it('retains the original operation and refuses duplicate ids with changed payloads',
  bindsOriginalPayload);

async function replayAndReadsHaveNoEffects() {
  const fixture = await start();
  const append = vi.spyOn(nats.store, 'append');
  const runner = new ProjectionRunner(pgDb(storage.queue), nats.reader,
    createLogger('instances', { level: 'silent' }));
  try {
    await runner.initialise(mcpInstances);
    await runner.run(mcpInstances);
    await runner.rebuild(mcpInstances);
    const status = await mcpInstanceStatus(nats.store, binding, 'alice', fixture.reference);
    expect(status).toMatchObject({ state: 'waking', runGeneration: 1 });
    const missing = await mcpInstanceChange(nats.store, binding, 'alice',
      fixture.reference, 'missing-change');
    expect(missing).toEqual({ status: 'unknown' });
    const rows = await storage.queue.query('SELECT state FROM mcp_instances WHERE instance_id=$1',
      [fixture.reference.instanceId]);
    expect(rows.rows[0]?.['state']).toMatchObject({ phase: 'waking' });
    expect(append).not.toHaveBeenCalled();
  } finally {
    append.mockRestore();
  }
}
it('replay and own status reads cannot wake, release material or make a 404 terminal',
  replayAndReadsHaveNoEffects);

async function refusesWake() {
  const fixture = await start();
  const wake = { ...fixture.stop, action: 'wake' };
  await expect(mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, wake))
    .rejects.toThrow('profile_or_admission_unavailable');
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('refuses wake while usable profiles and hosted admission are missing', refusesWake);

async function rejectsUnmatchedObservations() {
  const fixture = await start();
  const current = applyMcpInstance(undefined, fixture.event, fixture.sequence)!;
  const data = { instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'pod-uid',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' };
  const observation = envelope('test', fixture.event.subject, 'mcp.instance_observed', data);
  const observed = applyMcpInstance(current, observation, fixture.sequence + 1)!;
  for (const overrides of [{ runGeneration: 2 }, { startChangeRef: 'foreign' },
    { podUid: 'replacement' }, { workloadSpecDigest: 'd'.repeat(64) }]) {
    const changed = { ...observation, data: { ...data, ...overrides } };
    expect(() => applyMcpInstance(observed, changed, fixture.sequence + 2)).toThrow();
  }
  const missing = { ...observation, data: { ...data, state: 'unknown', reason: 'not_found' } };
  expect(applyMcpInstance(observed, missing, fixture.sequence + 2)?.phase).toBe('unknown');
  const terminal = { ...data, state: 'failed', reason: 'not_found' };
  expect(getEventDefinition('mcp.instance_observed')!.dataSchema.safeParse(terminal).success)
    .toBe(false);
  const callable = { ...data, state: 'callable' };
  expect(getEventDefinition('mcp.instance_observed')!.dataSchema.safeParse(callable).success)
    .toBe(false);
}
it('refuses stale runs, replacement Pods and callable claims; a 404 remains unknown',
  rejectsUnmatchedObservations);
