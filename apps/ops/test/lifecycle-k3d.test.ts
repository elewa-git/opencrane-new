import { execFile as execFileCallback } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { lifecycleHandlers, resumeComputer, suspendComputer, watchComputers } from '../src/lifecycle.ts';

const execFile = promisify(execFileCallback);
const live = process.env['LIFECYCLE_K3D'] === '1' && Boolean(process.env['PG_TEST_URL']);
function nested(input: unknown, name: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  const result: unknown = Reflect.get(input, name);
  return result;
}

it.skipIf(!live)('qualifies the event-driven lifecycle on k3d gVisor', async () => {
  expect(suspendComputer).toBeTypeOf('function');
  const namespace = `p22-${randomUUID().slice(0, 8)}`;
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
  try {
    expect(await run('config', 'current-context')).toBe('k3d-ocn');
    expect(await run('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name')).toBe('');
    await run('create', 'namespace', namespace);
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
    const delivered: unknown = JSON.parse(await k('exec', computerId, '--', 'cat', '/run/codex/computer.json'));
    expect(nested(delivered, 'id')).toBe(issued[0]!.id);
    const deliveredValue = nested(delivered, 'value');
    if (typeof deliveredValue !== 'string') throw new Error('No delivered credential');
    expect(await tokens.verify(deliveredValue, computerTokenAudience, issued[0]!.id)).toMatchObject({ computer: computerId });
    await k('exec', computerId, '--', 'node', '-e', "require('fs').writeFileSync('/home/agent/workspace/preserved','yes')");

    const readyEvent = (await allEvents()).findLast(event => event.type === 'computer.ready')!;
    const restricted = (...args: string[]) => run('--kubeconfig', kubeconfig, '-n', namespace, ...args);
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
    await expect(restricted('auth', 'can-i', 'get', 'pods', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'create', 'pods/exec', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'get', 'secrets', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'patch', 'pods', '-n', namespace)).rejects.toThrow();
    await expect(restricted('auth', 'can-i', 'get', 'sandboxtemplates', '-n', namespace)).rejects.toThrow();
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
    for (const suffix of ['sandbox', 'pod', 'claim']) {
      await run('delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding', `${namespace}-computer-${suffix}`, '--ignore-not-found');
    }
    await run('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s').catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 360_000);
