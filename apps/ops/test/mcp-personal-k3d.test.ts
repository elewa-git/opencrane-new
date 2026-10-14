import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import type { AppendCommand } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { mcpInstanceObservedSchema, mcpInstanceStopSchema, type EventEnvelope } from '@opencrane/events';
import { envelope, history, mcpInstanceCommand, mcpInstanceStatus,
  mcpAdminInstanceStop } from '@opencrane/models';
import { mcpInstanceId, mcpInstances, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { database } from '../../../libs/projections/test/database.ts';
import { McpKubernetes, kubectl } from '../src/mcp-kubernetes.ts';
import { stopMcpInstanceHandler } from '../src/mcp-stop.ts';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';

const live = process.env['MCP_PERSONAL_K3D'] === '1';
let namespace: string;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
const key = { siloId: 'test', userId: 'alice', serverId: 'server', startupAccessGeneration: 1 };

function testNamespace() {
  const stackId = process.env['DEV_STACK_ID'];
  if (stackId !== '1' && stackId !== '2') {
    throw new Error('Claim a secondary dev-stack slot and set DEV_STACK_ID to 1 or 2');
  }
  const path = join(homedir(), '.config/opencrane', `dev-stack-${stackId}`, 'stack-owner');
  if (!readFileSync(path, 'utf8').startsWith(`worktree=${resolve(import.meta.dirname, '../../..')}\n`)) {
    throw new Error('The secondary slot belongs to another worktree');
  }
  return `opencrane-dev-${stackId}-mcp-${randomUUID().slice(0, 8)}`;
}
function run(args: string[], input?: string) {
  return kubectl(['--context=k3d-ocn', '-n', namespace, ...args], input);
}
async function setup() {
  if (!live) return;
  namespace = testNamespace();
  await run(['create', 'namespace', namespace]);
  nats = await natsFixture();
  storage = await database('pg');
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  for (const memberId of ['alice', 'admin']) {
    const role = memberId === 'admin' ? 'admin' : 'member';
    const joined = envelope('test', `member-${memberId}`, 'member.joined',
      { memberId, role, email: `${memberId}@example.test`, displayName: memberId });
    await nats.store.append({ event: joined, expectedSequence: 0 });
    await auth.handler.handle(joined, storage.db);
  }
}
beforeAll(setup, 120_000);
async function cleanup() {
  await nats?.close();
  await storage?.close();
  await fga?.close();
  if (namespace) await run(['delete', 'namespace', namespace, '--wait=false']);
}
afterAll(cleanup, 90_000);

async function fixture(reason = 'owner_stop', recordPod = true) {
  const identity = { ...key, profileId: randomUUID() };
  const instanceId = mcpInstanceId(identity);
  const name = `mcp-${instanceId.slice(0, 32)}-1`;
  const labels = { 'opencrane.ai/mcp-instance': instanceId.slice(0, 32),
    'opencrane.ai/mcp-run': '1' };
  const annotations = { 'opencrane.ai/mcp-instance': instanceId,
    'opencrane.ai/mcp-spec': 'c'.repeat(64) };
  const container = { name: 'fixture', image: 'docker.io/rancher/local-path-provisioner:v0.0.37',
    imagePullPolicy: 'Never', command: ['/bin/sh', '-c', 'sleep 600'],
    resources: { requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '20m', memory: '32Mi' } } };
  const workload = { apiVersion: 'apps/v1', kind: 'StatefulSet',
    metadata: { name, labels, annotations }, spec: { replicas: 1, serviceName: name,
      selector: { matchLabels: labels }, template: { metadata: { labels },
        spec: { terminationGracePeriodSeconds: 0, containers: [container] } } } };
  await run(['create', '-f', '-'], JSON.stringify(workload));
  let podUid = '';
  for (let attempt = 0; attempt < 100 && !podUid; attempt++) {
    podUid = await run(['get', `pod/${name}-0`, '--ignore-not-found',
      '-o', 'jsonpath={.metadata.uid}']);
    if (!podUid) await delay(100);
  }
  expect(podUid).not.toBe('');
  await run(['wait', `pod/${name}-0`, '--for=condition=Ready', '--timeout=8s']);
  const subject = `mcp-instance-${instanceId}`;
  const requestedAt = new Date().toISOString();
  const start = { ...identity, instanceId, connectionId: 'connection', imageDigest: 'a'.repeat(64),
    installGeneration: 1, upstreamBindingDigest: 'b'.repeat(64), workloadSpecDigest: 'c'.repeat(64),
    runGeneration: 1, changeRef: randomUUID(), requestedAt,
    deadline: new Date(Date.parse(requestedAt) + 20_000).toISOString() };
  async function save(type: string, data: unknown) {
    const event = envelope('test', subject, type, data);
    const result = await nats.store.append({ event, expectedSequence: await nats.store.head(subject) });
    expect(result.status).toBe('appended');
    return event;
  }
  await save('mcp.instance_start_requested', start);
  const observation = { instanceId, runGeneration: 1, startChangeRef: start.changeRef,
    podUid, workloadSpecDigest: start.workloadSpecDigest, state: 'starting' };
  if (recordPod) await save('mcp.instance_observed', observation);
  const reference = { instanceId, profileId: identity.profileId, serverId: identity.serverId };
  const command = { changeRef: randomUUID(), expectedSequence: await nats.store.head(subject) };
  if (reason === 'admin_stop') {
    await mcpAdminInstanceStop(nats.store, binding, 'admin', reference, command);
  } else {
    await mcpInstanceCommand(nats.store, binding, 'alice', reference, { ...command, action: 'stop' });
  }
  const rows = await history(nats.store, subject, 'test');
  const stop = rows.at(-1)!.event;
  const calls: string[][] = [];
  let lose = '';
  let paused: (() => Promise<void>) | undefined;
  async function runner(args: string[], input?: string) {
    calls.push(args);
    const pause = paused;
    paused = undefined;
    await pause?.();
    const output = await run(args, input);
    if (lose && args.includes(lose)) {
      lose = '';
      throw new Error('Private kubectl output must not escape');
    }
    return output;
  }
  const kube = new McpKubernetes(namespace, runner);
  const handler = stopMcpInstanceHandler(nats.store, 'test', kube);
  function deliver(event: EventEnvelope = stop) {
    return handler.handle(event, storage.db);
  }
  async function absentCount() {
    const events = await history(nats.store, subject, 'test');
    function absent(row: (typeof events)[number]) {
      return row.event.type === 'mcp.instance_observed' && mcpInstanceObservedSchema.parse(row.event.data).state === 'absent';
    }
    return events.filter(absent).length;
  }
  function pauseNext(pause: () => Promise<void>) {
    paused = pause;
  }
  function loseReply(operation: string) {
    lose = operation;
  }
  async function version() {
    return run(['get', `statefulset/${name}`, '-o',
      'jsonpath={.metadata.uid}:{.metadata.resourceVersion}']);
  }
  return { name, subject, start, observation, reference, stop, calls, workload,
    deliver, absentCount, loseReply, pauseNext, save, version };
}

async function stopsAndRecovers(operation: string) {
  const fixtureCase = await fixture(operation === 'admin_stop' ? operation : 'owner_stop');
  if (operation === 'patch' || operation === 'delete') {
    fixtureCase.loseReply(operation);
    await expect(fixtureCase.deliver()).rejects.toThrow(/^MCP Kubernetes operation failed$/u);
  }
  await fixtureCase.deliver();
  expect(await fixtureCase.absentCount()).toBe(1);
  expect(await mcpInstanceStatus(nats.store, binding, 'alice', fixtureCase.reference))
    .toMatchObject({ state: 'sleeping' });
  expect(await run(['get', `statefulset/${fixtureCase.name}`, '--ignore-not-found', '-o', 'name']))
    .toBe('');
  fixtureCase.calls.length = 0;
  await fixtureCase.deliver();
  expect(fixtureCase.calls).toHaveLength(0);
  expect(await fixtureCase.absentCount()).toBe(1);
}
it.skipIf(!live).each(['owner_stop', 'admin_stop', 'patch', 'delete'])(
  'stops the exact run and recovers a lost %s reply', stopsAndRecovers, 90_000);

async function refusesForeign(change: string) {
  const current = await fixture();
  if (change === 'recreated-after-patch') {
    current.loseReply('patch');
    await expect(current.deliver()).rejects.toThrow(/^MCP Kubernetes operation failed$/u);
    const oldUid = await run(['get', `statefulset/${current.name}`,
      '-o', 'jsonpath={.metadata.uid}']);
    Reflect.set(current.workload.metadata.annotations, 'opencrane.ai/mcp-stop',
      JSON.stringify([current.stop.id, oldUid]));
  }
  if (change === 'extra') {
    const extra = structuredClone(current.workload);
    extra.metadata.name = 'foreign-' + current.name;
    await run(['create', '-f', '-'], JSON.stringify(extra));
  } else if (change.startsWith('recreated')) {
    await run(['delete', `statefulset/${current.name}`, '--wait=true']);
    await run(['create', '-f', '-'], JSON.stringify(current.workload));
  } else {
    const metadata = change === 'relabelled' ? { labels: { 'opencrane.ai/mcp-run': '9' } }
      : { annotations: { 'opencrane.ai/mcp-instance': 'foreign' } };
    const patch = JSON.stringify({ metadata });
    await run(['patch', `statefulset/${current.name}`, '--type=merge', '-p', patch]);
  }
  // Let the controller finish its own status updates before comparing versions.
  await delay(1500);
  const before = await current.version();
  await expect(current.deliver()).rejects.toThrow('MCP workload identity mismatch');
  expect(await current.version()).toBe(before);
  expect(await current.absentCount()).toBe(0);
}
it.skipIf(!live).each(['foreign', 'relabelled', 'recreated', 'recreated-after-patch', 'extra'])(
  'leaves a %s StatefulSet untouched', refusesForeign, 90_000);

async function alreadyGone() {
  const current = await fixture();
  await run(['delete', `statefulset/${current.name}`, '--wait=true']);
  await current.deliver();
  function deletion(args: string[]) {
    return args.includes('delete');
  }
  expect(current.calls.filter(deletion)).toHaveLength(0);
  expect(await current.absentCount()).toBe(1);
}
it.skipIf(!live)('records already absent objects without deleting', alreadyGone, 90_000);

async function concurrentStops() {
  const current = await fixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  async function pause() {
    entered.resolve();
    await released.promise;
  }
  current.pauseNext(pause);
  const lateDelivery = current.deliver();
  await entered.promise;
  await Promise.allSettled([current.deliver(), current.deliver()]);
  await current.deliver();
  expect(await current.absentCount()).toBe(1);
  const nextStart = { ...current.start, runGeneration: 2, changeRef: randomUUID() };
  await current.save('mcp.instance_start_requested', nextStart);
  const nextWorkload = structuredClone(current.workload);
  nextWorkload.metadata.name = `mcp-${current.start.instanceId.slice(0, 32)}-2`;
  nextWorkload.metadata.labels['opencrane.ai/mcp-run'] = '2';
  await run(['create', '-f', '-'], JSON.stringify(nextWorkload));
  await delay(1500);
  const versionArgs = ['get', `statefulset/${nextWorkload.metadata.name}`, '-o',
    'jsonpath={.metadata.uid}:{.metadata.resourceVersion}'];
  const nextVersion = await run(versionArgs);
  const before = await nats.store.head(current.subject);
  released.resolve();
  await lateDelivery;
  current.calls.length = 0;
  await Promise.all([current.deliver(), current.deliver()]);
  expect(current.calls).toHaveLength(0);
  expect(await nats.store.head(current.subject)).toBe(before);
  expect(await run(versionArgs)).toBe(nextVersion);
}
it.skipIf(!live)('saves one absent under concurrent delivery and ignores the old run',
  concurrentStops, 90_000);

async function ignoresInvalidTriggers() {
  const current = await fixture('owner_stop', false);
  await current.deliver();
  const other = await fixture();
  await other.deliver({ ...other.stop, id: randomUUID() });
  await other.deliver({ ...other.stop, silo: 'foreign' });
  const changed = { ...other.stop, data: { ...mcpInstanceStopSchema.parse(other.stop.data), changeRef: 'changed' } };
  await other.deliver(changed);
  expect(current.calls).toHaveLength(0);
  expect(other.calls).toHaveLength(0);
  expect(await current.absentCount()).toBe(0);
  expect(await other.absentCount()).toBe(0);
  const logger = createLogger('mcp-rebuild', { level: 'silent' });
  const projection = new ProjectionRunner(storage.db, nats.reader, logger);
  const before = await nats.store.head(other.subject);
  await projection.initialise(mcpInstances);
  await projection.run(mcpInstances);
  await mcpInstances.drop(storage.db);
  await mcpInstances.create(storage.db);
  for (const row of await history(nats.store, other.subject, 'test')) {
    await mcpInstances.apply(storage.db, row.event, row.sequence);
  }
  expect(other.calls).toHaveLength(0);
  expect(await nats.store.head(other.subject)).toBe(before);
  const wake = { action: 'wake', changeRef: randomUUID(), expectedSequence: before };
  await expect(mcpInstanceCommand(nats.store, binding, 'alice', other.reference, wake))
    .rejects.toThrow('profile_or_admission_unavailable');
}
it.skipIf(!live)('ignores missing Pods and unsaved triggers; replay and wake do no work',
  ignoresInvalidTriggers, 90_000);

async function retriesAppendConflict() {
  const current = await fixture();
  const append = nats.store.append.bind(nats.store);
  async function advanceBeforeAppend(command: AppendCommand) {
    const observation = envelope('test', current.subject,
      'mcp.instance_observed', current.observation);
    const competing = { event: observation, expectedSequence: command.expectedSequence };
    expect((await append(competing)).status).toBe('appended');
    const result = await append(command);
    expect(result.status).toBe('conflict');
    return result;
  }
  const spy = vi.spyOn(nats.store, 'append');
  spy.mockImplementationOnce(advanceBeforeAppend);
  try {
    await current.deliver();
    expect(await current.absentCount()).toBe(1);
    const rows = await history(nats.store, current.subject, 'test');
    const saved = rows.at(-1)!.event;
    expect(saved.principal?.kind).toBe('system');
    expect(saved.data).toMatchObject({ ...current.observation, state: 'absent',
      expectedSequence: rows.at(-2)!.sequence });
  } finally {
    spy.mockRestore();
  }
}
it.skipIf(!live)('rereads a real append conflict before recording exact absence',
  retriesAppendConflict, 90_000);

function gatesHandler() {
  expect(dispatcherHandlerNames({})).not.toContain('stop-mcp-instance');
  expect(dispatcherHandlerNames({ MCP_KUBE_NAMESPACE: '  ' })).not.toContain('stop-mcp-instance');
  expect(dispatcherHandlerNames({ MCP_KUBE_NAMESPACE: 'personal' })).toContain('stop-mcp-instance');
}
it('enables MCP stop only with its namespace', gatesHandler);
