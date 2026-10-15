import { execFile as execFileCallback } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { computerTokenAudience, tokenIssuer, type IssuedToken } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { dispatch, HandlerRuntime, provisionDispatcher } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { computers, ProjectionRunner, readEvents, rebuildComputersProjection } from '@opencrane/projections';
import { database } from '../../../libs/projections/test/database.ts';
import { SandboxClient } from '../src/kubernetes.ts';
import { field, history, lifecycleHandlers, resumeComputer, suspendComputer, watchComputers } from '../src/lifecycle.ts';

const execFile = promisify(execFileCallback);
const live = process.env['LIFECYCLE_K3D'] === '1' && Boolean(process.env['PG_TEST_URL']);
function testNamespace(): string {
  const stackId = process.env['DEV_STACK_ID'];
  if (stackId !== '1' && stackId !== '2') {
    throw new Error('Claim a secondary dev-stack slot and set DEV_STACK_ID to 1 or 2');
  }
  const ownerPath = join(homedir(), '.config/opencrane', `dev-stack-${stackId}`, 'stack-owner');
  const owner = readFileSync(ownerPath, 'utf8');
  if (!owner.startsWith(`worktree=${resolve(import.meta.dirname, '../../..')}\n`)) {
    throw new Error('The secondary slot belongs to another worktree');
  }
  return `opencrane-dev-${stackId}`;
}

async function waitForAdmissionRefusal(request: () => Promise<string>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await request();
    } catch (error) {
      if (error instanceof Error && /denied/u.test(error.message)) return;
      throw error;
    }
    // Wait for the API server to apply the changed policy before checking the worker.
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for the checked-image admission refusal');
}

function nested(input: unknown, name: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  const result: unknown = Reflect.get(input, name);
  return result;
}

it.skipIf(!live)('admits the checked computer template and rejects a forged Pod identity source', async () => {
  const namespace = testNamespace();
  const directory = await mkdtemp(join(tmpdir(), 'computer-admission-'));
  const k = async (...args: string[]) => (await execFile('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args])).stdout.trim();
  let created = false;
  try {
    expect(await k('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name')).toBe('');
    await k('create', 'namespace', namespace);
    created = true;
    await execFile('node', ['infra/dev-stack/computer-admission.mjs', namespace]);
    const template: unknown = JSON.parse(await readFile('apps/computer/sandbox-template.json', 'utf8'));
    const spec = nested(nested(nested(template, 'spec'), 'podTemplate'), 'spec');
    const path = join(directory, 'pod.json');
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'legitimate', labels: { app: 'computer' } }, spec };
    await writeFile(path, JSON.stringify(pod));
    await k('create', '--dry-run=server', '-f', path);
    // The desktop helper must read its actual Pod UID, never a caller's literal or another field.
    await writeFile(path, JSON.stringify(pod).replace('metadata.uid', 'metadata.name'));
    function createForgedIdentity() {
      return k('create', '--dry-run=server', '-f', path);
    }
    await waitForAdmissionRefusal(createForgedIdentity);
    await expect(createForgedIdentity()).rejects.toThrow(/denied/u);
    const sandbox = {
      apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox',
      metadata: { name: 'checked' },
      spec: { podTemplate: nested(nested(template, 'spec'), 'podTemplate'),
        operatingMode: 'Suspended' },
    };
    await writeFile(path, JSON.stringify(sandbox));
    await k('create', '-f', path);
    const older = olderTemplate(template);
    const oldPodTemplate = nested(nested(older.oldTemplate, 'spec'), 'podTemplate');
    const oldPodSpec = nested(oldPodTemplate, 'spec');
    const oldSandbox = { ...sandbox, metadata: { name: 'old-image' },
      spec: { ...sandbox.spec, podTemplate: oldPodTemplate } };
    await writeFile(path, JSON.stringify(oldSandbox));
    function createOldImage() {
      return k('create', '--dry-run=server', '-f', path);
    }
    await waitForAdmissionRefusal(createOldImage);
    await expect(createOldImage()).rejects.toThrow(/denied/u);
    const patch = { spec: { podTemplate: { spec: oldPodSpec } } };
    const imagePatch = JSON.stringify(patch);
    await expect(k('patch', 'sandbox/checked', '--type=merge', '--dry-run=server',
      '-p', imagePatch)).rejects.toThrow(/denied/u);
  } finally {
    if (created) {
      for (const suffix of ['sandbox', 'pod', 'claim']) await k('delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding', `${namespace}-computer-${suffix}`, '--ignore-not-found');
      await k('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=120s');
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!live).each([
  ['computer.ready', 'both', false], ['computer.resumed', 'both', false],
  ['computer.ready', 'both', true], ['computer.resumed', 'both', true],
  ['computer.ready', 'sandboxclaim', true], ['computer.resumed', 'sandbox', true],
  ['computer.resumed', 'sandboxclaim', true],
] as const)(
  'recovers deleted resources while %s (delete: %s, retain disk: %s)', async (latestType, deleted, retainDisk) => {
    const namespace = testNamespace();
    const directory = await mkdtemp(join(tmpdir(), 'opencrane-repair-'));
    const k = async (...args: string[]) => (await execFile('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args],
      { timeout: 180_000 })).stdout.trim();
    const nats = await natsFixture(), storage = await database('pg');
    let stop = new AbortController(), work: Promise<void> | undefined, watcherError: unknown, created = false;
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 120_000;
      while (!await check()) {
        if (watcherError instanceof Error) throw watcherError;
        expect(Date.now(), 'computer must recover without restarting the watcher').toBeLessThan(deadline);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    try {
      expect((await execFile('kubectl', ['config', 'current-context'])).stdout.trim()).toBe('k3d-ocn');
      expect(await k('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name')).toBe('');
      await k('create', 'namespace', namespace);
      created = true;
      await execFile('node', ['infra/dev-stack/computer-admission.mjs', namespace]);
      await k('create', 'configmap', 'computer-runtime', '--from-literal=gateway=http://127.0.0.1:3000');
      await k('apply', '-f', 'apps/computer/sandbox-template.json');
      await k('apply', '-f', 'apps/computer/network-policy.json');
      await k('apply', '-f', 'infra/dev-stack/computer-pool.json');
      await k('apply', '-f', 'infra/dev-stack/computer-worker-rbac.yaml');
      const config = await execFile('kubectl', ['--context=k3d-ocn', 'config', 'view', '--raw', '--minify', '--flatten', '-o', 'json']);
      const raw: unknown = JSON.parse(config.stdout), clusters = nested(raw, 'clusters');
      const cluster: unknown = Array.isArray(clusters) ? nested(clusters[0], 'cluster') : undefined;
      if (typeof cluster !== 'object' || cluster === null) throw new Error('Missing test cluster');
      const serviceToken = await k('create', 'token', 'computer-lifecycle', '--duration=1h');
      await writeFile(join(directory, 'kubeconfig'), JSON.stringify({ apiVersion: 'v1', kind: 'Config',
        clusters: [{ name: 'test', cluster }], users: [{ name: 'worker', user: { token: serviceToken } }],
        contexts: [{ name: 'test', context: { cluster: 'test', user: 'worker', namespace } }], 'current-context': 'test' }), { mode: 0o600 });
      const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      await writeFile(join(directory, 'key.pem'), key.privateKey, { mode: 0o600 });
      const tokens = await tokenIssuer({ privateKeyPath: join(directory, 'key.pem'), issuer: 'https://repair.test/' });
      const kube = new SandboxClient(join(directory, 'kubeconfig'), namespace, 'computer', '1Gi');
      const assistantId = 'repair-assistant', subject = `computer-${assistantId}`;
      const assistant: EventEnvelope = {
        id: randomUUID(), commandId: randomUUID(), type: 'assistant.created', subject: `assistant-${assistantId}`, silo: 'test', source: 'test',
        time: new Date().toISOString(), correlation: {}, principal: { kind: 'system', id: 'test' },
        data: { assistantId, ownerId: 'alice', kind: 'personal' },
      };
      await nats.seed([assistant]);
      await lifecycleHandlers(nats.store)[1].handle(assistant, storage.db);
      const computerId = field((await history(nats.store, subject)).at(-1)!.event.data, 'computerId');
      const start = () => {
        work = watchComputers(nats.store, kube, tokens, (id, token) => kube.credentials(id, token), 'test', 600_000, stop.signal)
          .catch((error: unknown) => { watcherError = error; });
      };
      const latest = async () => (await history(nats.store, subject)).at(-1)!.event;
      start();
      await until(async () => (await latest()).type === 'computer.ready');
      stop.abort(); await work;
      const ready = await latest();
      const pvcUid = await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}');
      await k('exec', computerId, '--', 'node', '-e', "require('fs').writeFileSync('/home/agent/workspace/preserved','yes')");
      if (latestType === 'computer.resumed') {
        await suspendComputer(nats.store, { assistantId, computerId, latest: ready, ready });
        await resumeComputer(nats.store, tokens, 'test', assistantId);
      }
      const before = await latest();
      expect(before.type).toBe(latestType);
      const resources = deleted === 'both' ? [`sandboxclaim/${computerId}`, `sandbox/${computerId}`] : [`${deleted}/${computerId}`];
      await k('delete', ...resources, '--wait=true',
        `--cascade=${retainDisk ? 'orphan' : 'background'}`);
      // Orphan deletion retains the disk and Pod; remove the old Pod before repair.
      if (retainDisk && deleted !== 'sandboxclaim') await k('delete', `pod/${computerId}`, '--wait=true');
      // A surviving claim may already have recreated its Sandbox.
      if (deleted !== 'sandbox') {
        expect(await k('get', ...resources, '--ignore-not-found', '-o', 'name')).toBe('');
        await expect(kube.state(computerId)).resolves.toBeUndefined();
      }
      stop = new AbortController(); start();
      await until(async () => {
        const event = await latest();
        // Exercise the existing loss reaction if repair replaces the ready Pod.
        if (event.type === 'computer.lost') await lifecycleHandlers(nats.store)[1].handle(event, storage.db);
        return event.type === 'computer.ready' && event.id !== before.id;
      });
      expect(watcherError).toBeUndefined();
      expect(nested((await latest()).data, 'podUid')).not.toBe(nested(ready.data, 'podUid'));
      if (deleted !== 'sandbox') {
        expect((await history(nats.store, subject)).some(row => row.event.type === 'computer.lost')).toBe(true);
        expect((await latest()).data).toMatchObject({ generation: 2 });
      }
      expect(await k('get', `sandboxclaim/${computerId}`, '-o', 'jsonpath={.metadata.name}')).toBe(computerId);
      if (retainDisk) {
        expect(await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}')).toBe(pvcUid);
        expect(await k('exec', computerId, '--', 'cat', '/home/agent/workspace/preserved')).toBe('yes');
      }
    } finally {
      stop.abort(); await work;
      await nats.close(); await storage.close();
      if (created) {
        for (const suffix of ['sandbox', 'pod', 'claim']) await k('delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding',
          `${namespace}-computer-${suffix}`, '--ignore-not-found');
        await k('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s');
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 240_000,
);

it.skipIf(!live)('qualifies the event-driven lifecycle on k3d gVisor', async () => {
  expect(suspendComputer).toBeTypeOf('function');
  const namespace = testNamespace();
  const directory = await mkdtemp(join(tmpdir(), 'opencrane-lifecycle-'));
  const kubeconfig = join(directory, 'kubeconfig.json');
  const signingKey = join(directory, 'signing.pem');
  const root = resolve(import.meta.dirname, '../../..');
  const run = async (...args: string[]) => (await execFile('kubectl', args, { cwd: root, timeout: 180_000,
    maxBuffer: 4_000_000 })).stdout.trim();
  const k = (...args: string[]) => run('-n', namespace, ...args);
  const until = async (check: () => Promise<boolean>, label: string, timeout = 180_000) => {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  };
  let nats: Awaited<ReturnType<typeof natsFixture>> | undefined;
  let storage: Awaited<ReturnType<typeof database>> | undefined;
  let runtime: HandlerRuntime | undefined;
  let dispatchTask: Promise<void> | undefined;
  let watchTask: Promise<void> | undefined;
  const dispatcher = new AbortController();
  let watcher = new AbortController();
  let created = false;
  try {
    expect(await run('config', 'current-context')).toBe('k3d-ocn');
    expect(await run('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name')).toBe('');
    await run('create', 'namespace', namespace);
    created = true;
    await execFile('node', ['infra/dev-stack/computer-admission.mjs', namespace], { cwd: root });
    await k('create', 'configmap', 'computer-runtime', '--from-literal=gateway=http://127.0.0.1:3000');
    await k('apply', '-f', 'apps/computer/sandbox-template.json');
    await k('apply', '-f', 'apps/computer/network-policy.json');
    await k('apply', '-f', 'infra/dev-stack/computer-pool.json');
    await k('apply', '-f', 'infra/dev-stack/computer-worker-rbac.yaml');
    const raw: unknown = JSON.parse(await run('config', 'view', '--raw', '--minify', '-o', 'json'));
    const clusters = nested(raw, 'clusters');
    const cluster: unknown = Array.isArray(clusters) ? nested(clusters[0], 'cluster') : undefined;
    if (typeof cluster !== 'object' || cluster === null) throw new Error('Current kubeconfig has no cluster');
    const serviceToken = await k('create', 'token', 'computer-lifecycle', '--duration=1h');
    await writeFile(kubeconfig, JSON.stringify({ apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'ocn', cluster }], users: [{ name: 'worker', user: { token: serviceToken } }],
      contexts: [{ name: 'ocn', context: { cluster: 'ocn', user: 'worker', namespace } }], 'current-context': 'ocn' }), { mode: 0o600 });
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(signingKey, key.privateKey, { mode: 0o600 });
    const tokens = await tokenIssuer({ privateKeyPath: signingKey, issuer: 'https://test.opencrane.invalid/' });
    const kube = new SandboxClient(kubeconfig, namespace, 'computer', '1Gi');
    const issued: IssuedToken[] = [];
    nats = await natsFixture();
    storage = await database('pg');
    const handlers = lifecycleHandlers(nats.store);
    const sink = async (id: string, token: IssuedToken) => { await kube.credentials(id, token); issued.push(token); };
    runtime = new HandlerRuntime({ db: storage.db, silo: 'test', handlers,
      logger: createLogger('lifecycle-live', { level: 'silent' }), expireInSeconds: 180 });
    await runtime.start();
    await runtime.work();
    await provisionDispatcher(nats.connection);
    dispatchTask = dispatch(nats.dispatcherConnection, runtime, dispatcher.signal);
    void dispatchTask.catch(() => undefined);
    const definition = getEventDefinition('member.joined');
    if (!definition || typeof definition.example !== 'object' || definition.example === null) throw new Error('Missing fixture');
    const joined = parseEventByType({ id: 'join-live', commandId: 'join-live', type: 'member.joined',
      subject: 'member-alice', silo: 'test', source: 'test', time: new Date().toISOString(),
      principal: { kind: 'human', id: 'alice' }, data: { ...definition.example, memberId: 'alice' } });
    if (!joined.success) throw new Error('Invalid joined fixture');
    expect((await nats.store.append({ event: joined.event, expectedSequence: 0 })).status).toBe('appended');
    const allEvents = async () => {
      const result: EventEnvelope[] = [];
      const head = await nats!.store.head();
      if (head) for await (const item of readEvents(nats!.store, 1, head)) result.push(item.event);
      return result;
    };
    await until(async () => (await allEvents()).some(event => event.type === 'computer.claimed'), 'committed claim intent');
    expect(await k('get', 'sandboxclaims', '-o', 'jsonpath={.items}')).toBe('[]');
    // Restart after the claim append, before its first Kubernetes effect.
    watchTask = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, watcher.signal);
    void watchTask.catch(() => undefined);
    const started = performance.now();
    await until(async () => (await allEvents()).some((event) => event.type === 'computer.ready'), 'join to Ready');
    const joinReadyMs = Math.round(performance.now() - started);
    const firstEvents = await allEvents();
    const assistant = firstEvents.find((event) => event.type === 'assistant.created')!;
    const claimed = firstEvents.find((event) => event.type === 'computer.claimed')!;
    const eventField = (event: EventEnvelope, name: string) => {
      const value: unknown = typeof event.data === 'object' && event.data !== null ? Reflect.get(event.data, name) : undefined;
      if (typeof value !== 'string') throw new Error(`Missing ${name}`);
      return value;
    };
    const assistantId = eventField(assistant, 'assistantId');
    const computerId = eventField(claimed, 'computerId');
    const pvcUid = await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}');
    await handlers[0].handle(joined.event, storage.db);
    await handlers[1].handle(assistant, storage.db);
    expect((await k('get', 'sandboxclaims', '-o', 'json')).match(/"kind": "SandboxClaim"/gu)?.length).toBe(1);
    expect((await allEvents()).filter((event) => event.type === 'assistant.created')).toHaveLength(1);
    expect((await allEvents()).filter((event) => event.type === 'computer.claimed')).toHaveLength(1);
    const delivered: unknown = JSON.parse(await k('exec', computerId, '--', 'cat',
      '/run/executor/credentials/computer.json'));
    const hash = createHash('sha256');
    hash.update(issued[0]!.value);
    const expectedDigest = hash.digest('hex');
    expect(nested(delivered, 'digest')).toBe(expectedDigest);
    expect(nested(delivered, 'expiresAt')).toBe(issued[0]!.expiresAt);
    expect(await tokens.verify(issued[0]!.value, computerTokenAudience, issued[0]!.id))
      .toMatchObject({ computer: computerId });
    await k('exec', computerId, '--', 'node', '-e', "require('fs').writeFileSync('/home/agent/workspace/preserved','yes')");

    const readyEvent = (await allEvents()).findLast(event => event.type === 'computer.ready')!;
    const restricted = (...args: string[]) => run('--kubeconfig', kubeconfig, '-n', namespace, ...args);
    for (const owner of [
      { apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxClaim', name: 'another-computer' },
      { apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', name: computerId },
    ]) {
      await expect(restricted('patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p',
        JSON.stringify({ metadata: { ownerReferences: [{ ...owner, uid: randomUUID(), controller: true, blockOwnerDeletion: true }] } })))
        .rejects.toThrow(/denied/);
    }
    const hostile: Record<string, unknown>[] = [
      { runtimeClassName: null }, { hostNetwork: true }, { hostPID: true }, { hostIPC: true },
      { volumes: [{ name: 'escape', hostPath: { path: '/' } }] },
      { volumes: [{ name: 'escape', secret: { secretName: 'private' } }] },
      { volumes: [{ name: 'escape', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }] },
      { containers: [{ name: 'computer', image: 'alpine:latest' }] },
    ];
    const template: unknown = JSON.parse(await readFile(join(root, 'apps/computer/sandbox-template.json'), 'utf8'));
    const podSpec = nested(nested(nested(template, 'spec'), 'podTemplate'), 'spec');
    const containers = nested(podSpec, 'containers');
    const volumes = nested(podSpec, 'volumes');
    const container: unknown = Array.isArray(containers) ? containers[0] : undefined;
    if (typeof podSpec !== 'object' || podSpec === null || typeof container !== 'object' || container === null || !Array.isArray(volumes)) throw new Error('Invalid checked template');
    for (const securityContext of [{ privileged: true }, { capabilities: { add: ['SYS_ADMIN'] } }]) {
      hostile.push({ containers: [{ ...container, securityContext }] });
    }
    for (const change of [{ command: ['sh', '-c', 'sleep infinity'] }, { envFrom: [{ secretRef: { name: 'private' } }] },
      { readinessProbe: { exec: { command: ['sh', '-c', 'id'] } } }]) {
      hostile.push({ containers: [{ ...container, ...change }] });
    }
    const legitimatePath = join(directory, 'legitimate.json');
    await writeFile(legitimatePath, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'legitimate', labels: { app: 'computer' } }, spec: podSpec }));
    await k('create', '--dry-run=server', '-f', legitimatePath);
    for (const change of hostile) {
      const extraVolumes: unknown = change['volumes'];
      const baseVolumes: unknown[] = volumes;
      const addedVolumes: unknown[] = Array.isArray(extraVolumes) ? extraVolumes : [];
      const spec = Array.isArray(extraVolumes) ? { volumes: [...baseVolumes, ...addedVolumes] } : change;
      await expect(restricted('patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p',
        JSON.stringify({ spec: { podTemplate: { spec } } }))).rejects.toThrow(/denied/);
      await expect(k('patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p',
        JSON.stringify({ spec: { podTemplate: { spec } } }))).rejects.toThrow(/denied/);
      const podPath = join(directory, 'hostile-pod.json');
      await writeFile(podPath, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'hostile', labels: { app: 'computer' } },
        spec: { ...podSpec, ...spec } }));
      await expect(k('create', '--dry-run=server', '-f', podPath)).rejects.toThrow(/denied/);
    }
    await restricted('patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p', JSON.stringify({ spec: { operatingMode: 'Suspended' } }));
    await restricted('patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p', JSON.stringify({ spec: { operatingMode: 'Running' } }));
    // Stop the health server without deleting the Pod, then restore it.
    const uidBefore = (await kube.state(computerId))!.podUid;
    await k('exec', computerId, '--', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'sh', '-c', 'kill -STOP $(pgrep -f "node.*bridge.ts" | head -1)');
    await until(async () => !(await kube.state(computerId))!.ready, 'readiness flap');
    expect((await allEvents()).filter(event => event.type === 'computer.lost')).toHaveLength(0);
    await k('exec', computerId, '--', 'setpriv', '--reuid=1000', '--regid=1000', '--clear-groups', 'sh', '-c', 'kill -CONT $(pgrep -f "node.*bridge.ts" | head -1)');
    await until(async () => (await kube.state(computerId))!.ready, 'health restored');
    expect((await kube.state(computerId))!.podUid).toBe(uidBefore);
    expect((await allEvents()).filter(event => event.type === 'computer.lost')).toHaveLength(0);
    watcher.abort();
    await watchTask;
    const failure = { readStream: nats.store.readStream.bind(nats.store), append: () => Promise.reject(new Error('injected append failure')) };
    await expect(suspendComputer(failure, { assistantId, computerId, latest: readyEvent })).rejects.toThrow('injected');
    expect((await allEvents()).at(-1)!.id).toBe(readyEvent.id);
    expect(await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.spec.operatingMode}')).toBe('Running');
    await suspendComputer(nats.store, { assistantId, computerId, latest: readyEvent, ready: readyEvent });
    // Crash window: committed intent exists, but no reconciler ran. A fresh watcher recovers it.
    expect(await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.spec.operatingMode}')).toBe('Running');
    watcher = new AbortController();
    watchTask = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, watcher.signal);
    await until(async () => (await kube.state(computerId))?.suspended === true, 'Sandbox suspended');
    watcher.abort();
    await watchTask;
    const initialToken = issued[0]!;
    watcher = new AbortController();
    watchTask = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, watcher.signal);
    const resumeStarted = performance.now();
    const resumedTokens = await Promise.all([resumeComputer(nats.store, tokens, 'test', assistantId), resumeComputer(nats.store, tokens, 'test', assistantId)]);
    const resumedToken = resumedTokens[0];
    for (const token of resumedTokens) await expect(tokens.verify(token.value, computerTokenAudience, resumedToken.id)).resolves.toBeDefined();
    expect((await allEvents()).filter(event => event.type === 'computer.resumed')).toHaveLength(1);
    await until(async () => (await allEvents()).filter((event) => event.type === 'computer.ready').length === 2, 'resume Ready');
    await suspendComputer(nats.store, { assistantId, computerId, latest: readyEvent, ready: readyEvent });
    expect(await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.spec.operatingMode}')).toBe('Running');
    const resumeMs = Math.round(performance.now() - resumeStarted);
    await expect(tokens.verify(initialToken.value, computerTokenAudience, resumedToken.id)).rejects.toThrow('rotated');
    expect(await k('exec', computerId, '--', 'cat', '/home/agent/workspace/preserved')).toBe('yes');

    await k('delete', 'pod', computerId, '--wait=false');
    await until(async () => (await allEvents()).some((event) => event.type === 'computer.lost'), 'lost event');
    await until(async () => (await allEvents()).filter((event) => event.type === 'computer.claimed').length === 2, 're-claim');
    await until(async () => (await allEvents()).filter((event) => event.type === 'computer.ready').length === 3, 'replacement Ready');
    expect(await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}')).toBe(pvcUid);
    const replacementTokenId = eventField((await allEvents()).findLast(event => event.type === 'computer.claimed')!, 'tokenId');
    expect(replacementTokenId).not.toBe(resumedToken.id);
    await expect(tokens.verify(resumedToken.value, computerTokenAudience, replacementTokenId)).rejects.toThrow('rotated');
    expect(await k('exec', computerId, '--', 'cat', '/home/agent/workspace/preserved')).toBe('yes');

    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('computers-live', { level: 'silent' }));
    await runner.initialise(computers);
    await runner.run(computers);
    const before = await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.metadata.resourceVersion}');
    await expect(rebuildComputersProjection(storage.db, nats.reader,
      createLogger('computers-rebuild-live', { level: 'silent' }), { verify: true })).resolves.toMatchObject({ changed: false });
    expect(await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.metadata.resourceVersion}')).toBe(before);
    expect((await storage.db.query('SELECT status, generation FROM computers')).rows)
      .toEqual([{ status: 'ready', generation: 2 }]);

    expect(await restricted('auth', 'can-i', 'get', 'sandboxes', '-n', namespace)).toBe('yes');
    expect(await restricted('auth', 'can-i', 'get', 'pods', '-n', namespace)).toBe('yes');
    expect(await restricted('auth', 'can-i', 'create', 'pods', '--subresource=exec', '-n', namespace)).toBe('yes');
    await expect(restricted('auth', 'can-i', 'get', 'secrets', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'patch', 'pods', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'get', 'sandboxtemplates', '-n', namespace))
      .resolves.toBe('yes');
    await expect(restricted('auth', 'can-i', 'patch', 'sandboxtemplates', '-n', namespace))
      .rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'get', 'sandboxes', '-n', 'default')).rejects.toThrow();
    await writeFile(join(directory, 'latency.json'), JSON.stringify({ joinReadyMs, resumeMs }));
    console.log(`LIFECYCLE_LATENCY ${JSON.stringify({ joinReadyMs, resumeMs })}`);
    expect(joinReadyMs).toBeGreaterThan(0);
    expect(resumeMs).toBeGreaterThan(0);
  } finally {
    watcher.abort();
    dispatcher.abort();
    await Promise.allSettled([watchTask, dispatchTask]);
    await runtime?.stop();
    await nats?.close();
    await storage?.close();
    if (created) {
      for (const suffix of ['sandbox', 'pod', 'claim']) {
        await run('delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding', `${namespace}-computer-${suffix}`, '--ignore-not-found');
      }
      await run('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s');
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 360_000);

function olderTemplate(checked: unknown, image?: string) {
  const oldTemplate = structuredClone(checked);
  if (typeof oldTemplate !== 'object' || oldTemplate === null) throw new Error('Invalid template');
  const podSpec = nested(nested(nested(oldTemplate, 'spec'), 'podTemplate'), 'spec');
  const containers = nested(podSpec, 'containers');
  if (!Array.isArray(containers)) throw new Error('Checked template has no containers');
  const container: unknown = containers[0];
  const checkedImage = nested(container, 'image');
  if (typeof checkedImage !== 'string' || typeof container !== 'object' || container === null) {
    throw new Error('Checked template has no computer image');
  }
  const oldImage = image ?? checkedImage.replace(/sha256:[a-f0-9]+/u, `sha256:${'0'.repeat(64)}`);
  Reflect.set(container, 'image', oldImage);
  return { oldTemplate, checkedImage, oldImage };
}

async function installsTestTemplate(directory: string, namespace: string, template: object) {
  const scripts = join(directory, 'infra/dev-stack');
  const computers = join(directory, 'apps/computer');
  await mkdir(scripts, { recursive: true });
  await mkdir(computers, { recursive: true });
  const templatePath = join(computers, 'sandbox-template.json');
  await writeFile(templatePath, JSON.stringify(template));
  const admissionPath = join(scripts, 'computer-admission.mjs');
  // Install the same admission rules with the older image for the starting computer.
  await copyFile('infra/dev-stack/computer-admission.mjs', admissionPath);
  await execFile('node', [admissionPath, namespace]);
  await execFile('kubectl', ['--context=k3d-ocn', '-n', namespace, 'apply', '-f', templatePath]);
}

async function resumesOnCheckedImage(suspendBeforeUpgrade: boolean) {
  const namespace = testNamespace();
  const directory = await mkdtemp(join(tmpdir(), 'computer-image-upgrade-'));
  const kubeconfig = join(directory, 'kubeconfig');
  const signingKey = join(directory, 'signing.pem');
  const nats = await natsFixture();
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  let watcherError: unknown;
  let created = false;
  async function k(...args: string[]) {
    const options = { timeout: 180_000, maxBuffer: 4_000_000 };
    const result = await execFile('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args], options);
    return result.stdout.trim();
  }
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 45_000;
    while (!await check()) {
      if (watcherError instanceof Error) throw watcherError;
      expect(Date.now(), 'computer must resume on the checked image').toBeLessThan(deadline);
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
  }
  const assistantId = 'upgrade-assistant';
  const computerId = 'upgrade-computer';
  const subject = `computer-${assistantId}`;
  async function record(type: string, extra: Record<string, unknown>) {
    const rows = await history(nats.store, subject);
    const event = {
      id: randomUUID(), commandId: randomUUID(), type, subject, silo: 'test',
      source: 'test', time: new Date().toISOString(),
      principal: { kind: 'system' as const, id: 'test' },
      data: { assistantId, computerId, ...extra },
    };
    const result = await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
    expect(result.status).toBe('appended');
  }
  try {
    expect(await k('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name')).toBe('');
    await k('create', 'namespace', namespace);
    created = true;
    const checked: unknown = JSON.parse(await readFile('apps/computer/sandbox-template.json', 'utf8'));
    const olderImage = await buildOlderImage(checked, directory, namespace);
    const { oldTemplate, checkedImage, oldImage } = olderTemplate(checked, olderImage);
    expect(oldImage.split('@')[1]).not.toBe(checkedImage.split('@')[1]);
    await installsTestTemplate(directory, namespace, oldTemplate);
    await k('create', 'configmap', 'computer-runtime', '--from-literal=gateway=http://127.0.0.1:3000');
    await k('apply', '-f', 'infra/dev-stack/computer-pool.json');
    await k('apply', '-f', 'infra/dev-stack/computer-worker-rbac.yaml');
    const configResult = await k('config', 'view', '--raw', '--minify', '--flatten', '-o', 'json');
    const raw: unknown = JSON.parse(configResult);
    const clusters = nested(raw, 'clusters');
    const cluster = Array.isArray(clusters) ? nested(clusters[0], 'cluster') : undefined;
    const token = await k('create', 'token', 'computer-lifecycle', '--duration=1h');
    const config = { apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'test', cluster }],
      users: [{ name: 'worker', user: { token } }],
      contexts: [{ name: 'test', context: { cluster: 'test', user: 'worker', namespace } }],
      'current-context': 'test' };
    await writeFile(kubeconfig, JSON.stringify(config), { mode: 0o600 });
    const keyOptions = { namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
    const key = generateKeyPairSync('ec', keyOptions);
    await writeFile(signingKey, key.privateKey, { mode: 0o600 });
    const tokens = await tokenIssuer({ privateKeyPath: signingKey, issuer: 'https://upgrade.test/' });
    const kube = new SandboxClient(kubeconfig, namespace, 'computer', '1Gi');
    await kube.claim(computerId, assistantId);
    async function ready() {
      return (await kube.state(computerId))?.ready === true;
    }
    await until(ready);
    const firstState = (await kube.state(computerId))!;
    const firstImageId = await k('get', `pod/${computerId}`, '-o',
      'jsonpath={.status.containerStatuses[0].imageID}');
    const pvcUid = await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}');
    await k('exec', computerId, '--', 'node', '-e',
      "require('fs').writeFileSync('/home/agent/workspace/preserved','yes')");
    await record('computer.claimed', { generation: 1, tokenId: 'token:initial' });
    await record('computer.ready', { generation: 1, podUid: firstState.podUid,
      sandboxUid: firstState.uid });
    async function suspended() {
      return (await kube.state(computerId))?.suspended === true;
    }
    if (suspendBeforeUpgrade) {
      await record('computer.suspended', {});
      await kube.mode(computerId, 'Suspended');
      await until(suspended);
    }
    await k('apply', '-f', 'apps/computer/sandbox-template.json');
    await execFile('node', ['infra/dev-stack/computer-admission.mjs', namespace]);
    const modePatch = JSON.stringify({ spec: { operatingMode: 'Running' } });
    function patchOldImageMode() {
      return k('--as', `system:serviceaccount:${namespace}:computer-lifecycle`,
        'patch', `sandbox/${computerId}`, '--type=merge', '--dry-run=server', '-p', modePatch);
    }
    await waitForAdmissionRefusal(patchOldImageMode);
    await expect(patchOldImageMode()).rejects.toThrow(/denied/u);
    await verifyWorkerPermissions(kubeconfig, namespace, computerId);
    if (suspendBeforeUpgrade) {
      await verifyUpgradeGuards(kubeconfig, namespace, computerId, directory);
    } else {
      await expect(kube.upgrade(computerId, assistantId)).rejects.toThrow(/suspended/u);
      await verifyUpgradeGuards(kubeconfig, namespace, computerId, directory, false);
    }
    if (suspendBeforeUpgrade) await resumeComputer(nats.store, tokens, 'test', assistantId);
    let deliveries = 0;
    async function deliver(name: string, credential: IssuedToken) {
      await kube.credentials(name, credential);
      deliveries++;
    }
    function failed(error: unknown) {
      watcherError = error;
    }
    work = watchComputers(nats.store, kube, tokens, deliver, 'test', 600_000, stop.signal);
    void work.catch(failed);
    if (!suspendBeforeUpgrade) {
      function credentialsRenewed() {
        return Promise.resolve(deliveries > 0);
      }
      await until(credentialsRenewed);
      const running = (await kube.state(computerId))!;
      expect(running.uid).toBe(firstState.uid);
      expect(running.podUid).toBe(firstState.podUid);
      expect(await k('get', `pod/${computerId}`, '-o', 'jsonpath={.spec.containers[0].image}'))
        .toBe(oldImage);
      const rows = await history(nats.store, subject);
      const readyEvent = rows.at(-1)!.event;
      await suspendComputer(nats.store, {
        assistantId, computerId, latest: readyEvent, ready: readyEvent,
      });
      await until(suspended);
      await resumeComputer(nats.store, tokens, 'test', assistantId);
    }
    async function resumed() {
      const rows = await history(nats.store, subject);
      return rows.at(-1)?.event.type === 'computer.ready';
    }
    await until(resumed);
    expect(watcherError).toBeUndefined();
    await verifyWorkerModeAndTemplate(kubeconfig, namespace, computerId);
    expect(await k('get', `sandbox/${computerId}`, '-o', 'jsonpath={.spec.operatingMode}'))
      .toBe('Running');
    expect(await k('get', `pod/${computerId}`, '-o', 'jsonpath={.spec.containers[0].image}'))
      .toBe(checkedImage);
    expect((await kube.state(computerId))!.uid).toBe(firstState.uid);
    expect((await kube.state(computerId))!.podUid).not.toBe(firstState.podUid);
    expect(await k('get', `pod/${computerId}`, '-o',
      'jsonpath={.status.containerStatuses[0].imageID}')).not.toBe(firstImageId);
    expect(await k('get', `pvc/home-${computerId}`, '-o', 'jsonpath={.metadata.uid}')).toBe(pvcUid);
    expect(await k('exec', computerId, '--', 'cat', '/home/agent/workspace/preserved')).toBe('yes');
  } finally {
    stop.abort();
    await work;
    await nats.close();
    if (created) {
      for (const suffix of ['sandbox', 'pod', 'claim']) {
        await k('delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding',
          `${namespace}-computer-${suffix}`, '--ignore-not-found');
      }
      await k('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s');
    }
    await rm(directory, { recursive: true, force: true });
  }
}

it.skipIf(!live).each([true, false])(
  'resumes a retained computer on the checked image with its home intact (already suspended: %s)',
  resumesOnCheckedImage, 240_000);

async function buildOlderImage(checked: unknown, directory: string, namespace: string) {
  const templateSpec = nested(nested(nested(checked, 'spec'), 'podTemplate'), 'spec');
  const containers = nested(templateSpec, 'containers');
  const image = Array.isArray(containers) ? nested(containers[0], 'image') : undefined;
  if (typeof image !== 'string') throw new Error('Missing checked image');
  const base = image.replace('k3d-ocn-registry:5000', '127.0.0.1:5001');
  const addressResult = await execFile('docker', ['inspect', 'k3d-ocn-registry', '--format',
    '{{(index .NetworkSettings.Networks "k3d-ocn").IPAddress}}']);
  const address = addressResult.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(address)) throw new Error('Missing registry address');
  const tag = `${address}:5000/opencrane/computer:retained-${namespace}`;
  const resultPath = join(directory, 'image-build.json');
  const output = `type=image,name=${tag},push=true,registry.insecure=true`;
  await writeFile(join(directory, 'Dockerfile'), `FROM ${base}\nLABEL test.image=retained\n`);
  // Push a new tag through the private bridge. Keep every existing image tag unchanged.
  await execFile('nice', ['-n', '10', 'docker', 'buildx', 'build', '--network=none',
    '--output', output, '--metadata-file', resultPath, directory],
  { timeout: 180_000, maxBuffer: 4_000_000 });
  const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
  const digest = nested(result, 'containerimage.digest');
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('Older test image has no digest');
  }
  return `k3d-ocn-registry:5000/opencrane/computer@${digest}`;
}

async function verifyWorkerPermissions(kubeconfig: string, namespace: string, name: string) {
  const prefix = ['--kubeconfig', kubeconfig, '-n', namespace];
  const deleteArgs = [...prefix, 'delete', `sandbox/${name}`, '--dry-run=server'];
  await expect.soft(execFile('kubectl', deleteArgs)).rejects.toThrow(/forbidden/u);
  const patch = JSON.stringify({ metadata: { ownerReferences: [] } });
  const pvcArgs = [...prefix, 'patch', `pvc/home-${name}`, '--type=merge',
    '--dry-run=server', '-p', patch];
  await expect.soft(execFile('kubectl', pvcArgs)).rejects.toThrow(/forbidden/u);
}

async function verifyWorkerModeAndTemplate(kubeconfig: string, namespace: string, name: string) {
  const prefix = ['--kubeconfig', kubeconfig, '-n', namespace];
  const patch = JSON.stringify({ spec: { operatingMode: 'Running' } });
  await execFile('kubectl', [...prefix, 'patch', `sandbox/${name}`, '--type=merge',
    '--dry-run=server', '-p', patch]);
  const changed = JSON.stringify({ spec: { podTemplate: { spec: { hostNetwork: true } } } });
  await expect(execFile('kubectl', [...prefix, 'patch', `sandbox/${name}`, '--type=merge',
    '--dry-run=server', '-p', changed])).rejects.toThrow(/denied/u);
}

async function verifyUpgradeGuards(kubeconfig: string, namespace: string, name: string,
  directory: string, suspended = true) {
  const prefix = ['--kubeconfig', kubeconfig, '-n', namespace];
  const current = await execFile('kubectl', [...prefix, 'get', `sandbox/${name}`, '-o', 'json']);
  const sandbox: unknown = JSON.parse(current.stdout);
  const templateResult = await execFile('kubectl', [...prefix, 'get', 'sandboxtemplate/computer',
    '-o', 'json']);
  const template: unknown = JSON.parse(templateResult.stdout);
  const podTemplate = nested(nested(template, 'spec'), 'podTemplate');
  const oldPodTemplate = nested(nested(sandbox, 'spec'), 'podTemplate');
  setField(podTemplate, 'metadata', nested(oldPodTemplate, 'metadata'));
  const podSpec = nested(podTemplate, 'spec');
  const volumes = nested(podSpec, 'volumes');
  if (!Array.isArray(volumes)) throw new Error('Missing volumes');
  for (let index = 0; index < volumes.length; index++) {
    if (nested(volumes[index], 'name') === 'home') {
      volumes[index] = { name: 'home', persistentVolumeClaim: { claimName: `home-${name}` } };
    }
  }
  setField(nested(sandbox, 'spec'), 'podTemplate', podTemplate);
  const path = join(directory, 'upgrade.json');
  const args = [...prefix, 'replace', '--dry-run=server', '-f', path];
  await writeFile(path, JSON.stringify(sandbox));
  if (!suspended) {
    await expect(execFile('kubectl', args)).rejects.toThrow(/denied/u);
    return;
  }
  await execFile('kubectl', args);
  const guards = ['labels', 'owners', 'annotations', 'finalizers', 'mode', 'spec',
    'image', 'volumes', 'other-home', 'pod-labels', 'pod-annotations', 'stale-version'];
  for (const guard of guards) {
    const changed = structuredClone(sandbox);
    const metadata = nested(changed, 'metadata');
    const spec = nested(changed, 'spec');
    const proposed = nested(spec, 'podTemplate');
    if (guard === 'labels') setField(metadata, 'labels', { changed: 'yes' });
    if (guard === 'owners') setField(metadata, 'ownerReferences', []);
    if (guard === 'annotations') setField(metadata, 'annotations', { changed: 'yes' });
    if (guard === 'finalizers') setField(metadata, 'finalizers', ['test.example/keep']);
    if (guard === 'mode') setField(spec, 'operatingMode', 'Running');
    if (guard === 'spec') setField(spec, 'shutdownTime', '2099-01-01T00:00:00Z');
    if (guard === 'image') {
      const proposedContainers = nested(nested(proposed, 'spec'), 'containers');
      if (!Array.isArray(proposedContainers)) throw new Error('Missing containers');
      setField(proposedContainers[0], 'image', 'unreviewed:latest');
    }
    if (guard === 'volumes') setField(nested(proposed, 'spec'), 'volumes', []);
    if (guard === 'other-home') {
      const proposedVolumes = nested(nested(proposed, 'spec'), 'volumes');
      if (!Array.isArray(proposedVolumes)) throw new Error('Missing volumes');
      const otherHome = { name: 'home', persistentVolumeClaim: { claimName: 'home-other' } };
      proposedVolumes[0] = otherHome;
    }
    if (guard === 'pod-labels') setField(nested(proposed, 'metadata'), 'labels', { app: 'computer' });
    if (guard === 'pod-annotations') setField(nested(proposed, 'metadata'), 'annotations', { changed: 'yes' });
    if (guard === 'stale-version') setField(metadata, 'resourceVersion', '1');
    await writeFile(path, JSON.stringify(changed));
    await expect.soft(execFile('kubectl', args), guard).rejects.toThrow(/denied|Conflict/u);
  }
}

function setField(object: unknown, name: string, value: unknown): void {
  if (typeof object !== 'object' || object === null) throw new Error('Missing object');
  Reflect.set(object, name, value);
}
