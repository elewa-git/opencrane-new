import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import type { AppendCommand } from '@opencrane/event-store';
import { getEventDefinition } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { applyMcpInstance, mcpInstanceId, mcpInstances, pgDb, ProjectionRunner }
  from '@opencrane/projections';
import { envelope, history, mcpInstanceCommand, mcpInstanceStatus,
  mcpInstanceChange, mcpAdminInstanceStop, mcpAdminInstanceChange } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const key = { siloId: 'test', userId: 'alice', profileId: 'profile-id', serverId: 'server-id',
  startupAccessGeneration: 1 };

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  for (const memberId of ['alice', 'bob', 'carol', 'dave']) {
    const joined = envelope('test', `member-${memberId}`, 'member.joined',
      { memberId, role: memberId === 'carol' ? 'admin' : memberId === 'dave'
        ? 'owner' : 'member', email: `${memberId}@example.test`, displayName: memberId });
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
  const requestedAt = new Date().toISOString();
  const deadline = new Date(Date.parse(requestedAt) + 20_000).toISOString();
  const data = { ...identity, instanceId, connectionId: 'connection-id',
    imageDigest: 'a'.repeat(64), installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64),
    workloadSpecDigest: 'c'.repeat(64), runGeneration: 1, changeRef: `start-${counter}`,
    requestedAt, deadline };
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
  const observation = { instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' };
  const started = envelope('test', fixture.event.subject, 'mcp.instance_observed', observation);
  const observed = await nats.store.append({ event: started, expectedSequence: fixture.sequence });
  if (observed.status !== 'appended') throw new Error('Observation fixture failed');
  fixture.stop.expectedSequence = observed.sequence;
  const receipt = await mcpInstanceCommand(nats.store, binding, 'alice',
    fixture.reference, fixture.stop);
  expect(receipt.status).toBe('applied');
  expect(await mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, fixture.stop))
    .toEqual(receipt);
  const changed = { ...fixture.stop, expectedSequence: receipt.sequence };
  await expect(mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, changed))
    .rejects.toThrow();
  const absent = envelope('test', fixture.event.subject, 'mcp.instance_observed',
    { ...observation, state: 'absent' });
  const stopped = await nats.store.append({ event: absent, expectedSequence: receipt.sequence });
  if (stopped.status !== 'appended') throw new Error('Absence fixture failed');
  const next = envelope('test', fixture.event.subject, 'mcp.instance_start_requested',
    { ...fixture.data, runGeneration: 2, changeRef: 'next-run' });
  expect((await nats.store.append({ event: next, expectedSequence: stopped.sequence })).status)
    .toBe('appended');
  expect(await mcpInstanceCommand(nats.store, binding, 'alice', fixture.reference, fixture.stop))
    .toEqual(receipt);
  expect(await mcpInstanceChange(nats.store, binding, 'alice', fixture.reference,
    fixture.stop.changeRef)).toEqual(receipt);
  const original = await mcpInstanceChange(nats.store, binding, 'alice', fixture.reference,
    fixture.data.changeRef);
  expect(original).toMatchObject({ status: 'applied', operation: 'mcp.instance_start_requested',
    sequence: fixture.sequence, runGeneration: 1 });
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(5);
}
it('retains the original operation and refuses duplicate ids with changed payloads',
  bindsOriginalPayload);

async function refusesConcurrentChangedPayload() {
  const fixture = await start();
  const originalAppend = nats.store.append.bind(nats.store);
  let competingSequence: number | undefined;
  async function saveCompetingStop(command: AppendCommand) {
    // Advance the instance after the first stop reads it, then save the same id at that position.
    const observation = envelope('test', fixture.event.subject, 'mcp.instance_observed', {
      instanceId: fixture.reference.instanceId, runGeneration: 1,
      startChangeRef: fixture.data.changeRef, podUid: 'original-pod',
      workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting',
    });
    const observed = await originalAppend({ event: observation,
      expectedSequence: fixture.sequence });
    if (observed.status !== 'appended') throw new Error('Observation fixture failed');
    const changed = { ...fixture.stop, expectedSequence: observed.sequence };
    const competing = await mcpInstanceCommand(nats.store, binding, 'alice',
      fixture.reference, changed);
    competingSequence = competing.sequence;
    const recovered = await originalAppend(command);
    expect(recovered).toEqual({ status: 'appended', sequence: competingSequence });
    return recovered;
  }
  const append = vi.spyOn(nats.store, 'append');
  append.mockImplementationOnce(saveCompetingStop);
  try {
    await expect(mcpInstanceCommand(nats.store, binding, 'alice',
      fixture.reference, fixture.stop)).rejects.toThrow('Instance change payload mismatch');
    const rows = await history(nats.store, fixture.event.subject, 'test');
    expect(rows).toHaveLength(3);
    expect(rows[2]?.sequence).toBe(competingSequence);
    expect(rows[2]?.event.commandId).toBe(fixture.stop.changeRef);
    expect(rows[2]?.event.data).toMatchObject({ expectedSequence: rows[1]?.sequence });
    expect(rows[2]?.event.data).not.toMatchObject({ expectedSequence: fixture.sequence });
  } finally {
    append.mockRestore();
  }
}
it('refuses concurrent duplicate recovery with a changed payload', refusesConcurrentChangedPayload);

async function replayAndReadsHaveNoEffects() {
  const fixture = await start();
  const append = vi.spyOn(nats.store, 'append');
  const clock = vi.spyOn(Date, 'now');
  const runner = new ProjectionRunner(pgDb(storage.queue), nats.reader,
    createLogger('instances', { level: 'silent' }));
  try {
    await runner.initialise(mcpInstances);
    await runner.run(mcpInstances);
    await runner.rebuild(mcpInstances);
    const status = await mcpInstanceStatus(nats.store, binding, 'alice', fixture.reference);
    expect(status).toMatchObject({ state: 'waking', runGeneration: 1 });
    clock.mockReturnValue(Date.parse(fixture.data.deadline) + 1);
    expect(await mcpInstanceStatus(nats.store, binding, 'alice', fixture.reference))
      .toMatchObject({ state: 'unavailable', reason: 'wake_deadline_exceeded' });
    const missing = await mcpInstanceChange(nats.store, binding, 'alice',
      fixture.reference, 'missing-change');
    expect(missing).toEqual({ status: 'unknown' });
    const rows = await storage.queue.query<{ state: unknown }>(
      'SELECT state FROM mcp_instances WHERE instance_id=$1',
      [fixture.reference.instanceId]);
    expect(rows.rows[0]?.['state']).toMatchObject({ phase: 'waking' });
    expect(append).not.toHaveBeenCalled();
  } finally {
    append.mockRestore();
    clock.mockRestore();
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
  const foreignKey = { ...fixture.event, data: { ...fixture.data, userId: 'bob' } };
  expect(() => applyMcpInstance(undefined, foreignKey, fixture.sequence)).toThrow();
  const data = { instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'pod-uid',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' };
  const observation = envelope('test', fixture.event.subject, 'mcp.instance_observed', data);
  const observed = applyMcpInstance(current, observation, fixture.sequence + 1)!;
  const staleRevision = { ...observation, data: { ...data, expectedSequence: 0 } };
  function applyStaleRevision() {
    return applyMcpInstance(current, staleRevision, fixture.sequence + 1);
  }
  expect(applyStaleRevision).toThrow();
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

async function adminStopAndRead() {
  const fixture = await start();
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: fixture.stop.expectedSequence };
  const saved = await mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference, command);
  expect(saved).toEqual({ status: 'applied', changeRef: command.changeRef,
    sequence: fixture.sequence + 1, runGeneration: 1, reason: 'admin_stop' });
  expect(await mcpInstanceStatus(nats.store, binding, 'alice', fixture.reference))
    .toMatchObject({ state: 'stopping', reason: 'admin_stop' });
  expect(await mcpAdminInstanceChange(nats.store, binding, 'carol', fixture.reference,
    command.changeRef)).toEqual(saved);
  expect(await mcpAdminInstanceChange(nats.store, binding, 'carol', fixture.reference,
    fixture.data.changeRef)).toEqual({ status: 'unknown' });
  expect(await mcpAdminInstanceChange(nats.store, binding, 'dave', fixture.reference,
    command.changeRef)).toEqual({ status: 'unknown' });
  expect(await mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference, command))
    .toEqual(saved);
  await expect(mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference, command))
    .rejects.toThrow();
  await expect(mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference,
    { ...command, expectedSequence: saved.sequence })).rejects.toThrow();
  await expect(mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference,
    { ...command, changeRef: fixture.data.changeRef })).rejects.toThrow();
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(2);
}
it('saves one admin stop and exposes only that admin’s original change', adminStopAndRead);

async function adminRefusals() {
  const fixture = await start();
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: fixture.stop.expectedSequence };
  const read = vi.spyOn(nats.store, 'readStream');
  try {
    for (const memberId of ['alice', 'bob']) {
      await expect(mcpAdminInstanceStop(nats.store, binding, memberId,
        fixture.reference, command)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalledWith(fixture.event.subject,
      expect.anything(), expect.anything());
  } finally {
    read.mockRestore();
  }
  for (const reference of [{ ...fixture.reference, profileId: 'foreign' },
    { ...fixture.reference, serverId: 'foreign' },
    { ...fixture.reference, profileId: 'My account' }]) {
    await expect(mcpAdminInstanceStop(nats.store, binding, 'carol', reference,
      command)).rejects.toThrow();
  }
  await expect(mcpAdminInstanceStop(nats.store, { ...binding, silo: 'foreign' },
    'carol', fixture.reference, command)).rejects.toThrow();
  await expect(mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference,
    { ...command, expectedSequence: 0 })).rejects.toThrow();
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('refuses member, foreign identity and stale admin commands without an event', adminRefusals);

async function refusesDemotedAdmin() {
  const fixture = await start();
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: fixture.stop.expectedSequence };
  const originalRead = nats.store.readStream.bind(nats.store);
  let changed = false;
  async function* demoteDuringHistory(subject: string, from?: number, deadline?: number) {
    yield* originalRead(subject, from, deadline);
    if (subject !== fixture.event.subject || changed) return;
    changed = true;
    const event = envelope('test', 'member-carol', 'member.role_changed', {
      memberId: 'carol', previousRole: 'admin', newRole: 'member', changedBy: 'dave' });
    await nats.seed([event]);
  }
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(demoteDuringHistory);
  try {
    await expect(mcpAdminInstanceStop(nats.store, binding, 'carol', fixture.reference,
      command)).rejects.toThrow();
  } finally {
    read.mockRestore();
  }
  expect(await nats.store.head(fixture.event.subject)).toBe(fixture.sequence);
}
it('checks the admin role again after instance history is loaded', refusesDemotedAdmin);

async function adminRetryAfterLaterRun() {
  const fixture = await start();
  const observation = { instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, podUid: 'admin-pod',
    workloadSpecDigest: fixture.data.workloadSpecDigest, state: 'starting' };
  const observed = envelope('test', fixture.event.subject, 'mcp.instance_observed', observation);
  const starting = await nats.store.append({ event: observed,
    expectedSequence: fixture.sequence });
  if (starting.status !== 'appended') throw new Error('Observation fixture failed');
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: starting.sequence };
  const saved = await mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference, command);
  let projected: ReturnType<typeof applyMcpInstance>;
  const rows = await history(nats.store, fixture.event.subject, 'test');
  for (const row of rows) {
    projected = applyMcpInstance(projected, row.event, row.sequence);
  }
  const lateStarting = envelope('test', fixture.event.subject,
    'mcp.instance_observed', observation);
  expect(applyMcpInstance(projected, lateStarting, saved.sequence + 1))
    .toMatchObject({ phase: 'stopping', reason: 'admin_stop' });
  await expect(mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference,
    { ...command, changeRef: 'while-stopping' })).rejects.toThrow();
  const absent = envelope('test', fixture.event.subject, 'mcp.instance_observed',
    { ...observation, state: 'absent' });
  const sleeping = await nats.store.append({ event: absent,
    expectedSequence: saved.sequence });
  if (sleeping.status !== 'appended') throw new Error('Absence fixture failed');
  await expect(mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference,
    { ...command, changeRef: 'while-sleeping',
      expectedSequence: sleeping.sequence })).rejects.toThrow();
  const next = envelope('test', fixture.event.subject, 'mcp.instance_start_requested',
    { ...fixture.data, runGeneration: 2, changeRef: 'later-run' });
  await nats.store.append({ event: next, expectedSequence: sleeping.sequence });
  expect(await mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference, command))
    .toEqual(saved);
  const append = vi.spyOn(nats.store, 'append');
  try {
    const runner = new ProjectionRunner(pgDb(storage.queue), nats.reader,
      createLogger('admin-stops', { level: 'silent' }));
    await runner.initialise(mcpInstances);
    await runner.rebuild(mcpInstances);
    expect(await mcpAdminInstanceChange(nats.store, binding, 'dave', fixture.reference,
      command.changeRef)).toEqual(saved);
    expect(await mcpAdminInstanceChange(nats.store, binding, 'dave', fixture.reference,
      'missing-change')).toEqual({ status: 'unknown' });
    expect(append).not.toHaveBeenCalled();
  } finally {
    append.mockRestore();
  }
}
it('keeps the admin receipt after a later run and refuses sleeping or stopping runs',
  adminRetryAfterLaterRun);

async function concurrentAdminStops() {
  const fixture = await start();
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: fixture.stop.expectedSequence };
  const attempts = [
    mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference, command),
    mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference, command),
  ];
  const receipts = await Promise.all(attempts);
  expect(receipts[1]).toEqual(receipts[0]);
  expect(await history(nats.store, fixture.event.subject, 'test')).toHaveLength(2);
}
it('saves only one event for concurrent unchanged admin requests', concurrentAdminStops);

async function ownerChangeCannotBecomeAdminChange() {
  const fixture = await start();
  const ownerStop = await mcpInstanceCommand(nats.store, binding, 'alice',
    fixture.reference, fixture.stop);
  const command = { changeRef: fixture.stop.changeRef,
    expectedSequence: fixture.stop.expectedSequence };
  await expect(mcpAdminInstanceStop(nats.store, binding, 'dave', fixture.reference,
    command)).rejects.toThrow();
  expect(await mcpAdminInstanceChange(nats.store, binding, 'dave', fixture.reference,
    command.changeRef)).toEqual({ status: 'unknown' });
  expect(await nats.store.head(fixture.event.subject)).toBe(ownerStop.sequence);
}
it('does not adopt an owner’s stop under the admin’s change reference',
  ownerChangeCannotBecomeAdminChange);

async function foldRejectsForeignOwnerStop() {
  const fixture = await start();
  const current = applyMcpInstance(undefined, fixture.event, fixture.sequence)!;
  const event = { ...fixture.event, type: 'mcp.instance_stop_requested',
    principal: { kind: 'human' as const, id: 'carol' }, data: {
    instanceId: fixture.reference.instanceId, runGeneration: 1,
    startChangeRef: fixture.data.changeRef, changeRef: 'bad-owner',
    expectedSequence: fixture.sequence, requestedBy: 'carol', reason: 'owner_stop' } };
  expect(() => applyMcpInstance(current, event, fixture.sequence + 1)).toThrow();
}
it('refuses an owner stop requested by someone else', foldRejectsForeignOwnerStop);
