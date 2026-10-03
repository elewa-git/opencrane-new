// Disposable wake qualification. The only model endpoint is an in-namespace stub.
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenIssuer, type IssuedToken } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { conversations, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { database } from '../../libs/projections/test/database.ts';
import { SandboxClient } from '../../apps/ops/src/kubernetes.ts';
import { history, field, lifecycleHandlers, suspendComputer, watchComputers } from '../../apps/ops/src/lifecycle.ts';
import { chatCommand, chatHistory } from '../../apps/server/src/chat/commands.ts';
import { conversationKeys } from '../../apps/server/src/chat/keys.ts';
import { watchBridges } from '../../apps/server/src/chat/bridge.ts';

const run = promisify(execFile);
const label = process.argv[2] ?? 'before';
assert.match(label, /^[a-z0-9-]+$/u);
const namespace = `wake-latency-${randomUUID().slice(0, 8)}`;
const directory = await mkdtemp(`${tmpdir()}/wake-latency-`);
const output = `.tools/wake-latency/${label}`;
await mkdir(output, { recursive: true });
const k = async (...args: string[]) => (await run('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args], { timeout: 120_000, maxBuffer: 4_000_000 })).stdout.trim();
const apply = async (object: object) => {
  await writeFile(`${directory}/resource.json`, JSON.stringify(object));
  await k('apply', '-f', `${directory}/resource.json`);
};
async function until(check: () => Promise<boolean> | boolean, name: string) {
  const deadline = Date.now() + 120_000;
    while (!await check()) { stop.signal.throwIfAborted(); assert(Date.now() < deadline, `Timed out: ${name}`); await delay(50); }
}
type Trace = Record<string, number>;
let trace: Trace | undefined;
const stamp = (stage: string, at = Date.now()) => { if (trace && trace[stage] === undefined) trace[stage] = at; };
const children: ChildProcess[] = [];
// kubectl emits consecutive JSON documents. Consume only complete documents.
function watch(kind: string, consume: (object: unknown) => void) {
  const child = spawn('kubectl', ['--context=k3d-ocn', '-n', namespace, 'get', kind, '--watch', '--output-watch-events', '-o', 'json']);
  children.push(child);
  let buffer = '', depth = 0, quoted = false, escaped = false, start = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    for (const character of chunk.toString()) {
      buffer += character;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') { if (depth === 0) start = buffer.length - 1; depth++; }
      else if (character === '}' && --depth === 0) {
        consume(JSON.parse(buffer.slice(start)) as unknown); buffer = ''; start = 0;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}
function value(object: unknown, ...path: string[]): unknown {
  for (const key of path) {
    if (typeof object !== 'object' || object === null) return undefined;
    object = Reflect.get(object, key);
  }
  return object;
}
class TimedKube extends SandboxClient {
  override async mode(name: string, mode: 'Running' | 'Suspended') {
    if (mode === 'Running') stamp('running_patch_start');
    await super.mode(name, mode);
    if (mode === 'Running') stamp('running_patch');
  }
  override async credentials(name: string, token: IssuedToken, force = false) {
    stamp('credential_start');
    await super.credentials(name, token, force);
    stamp(force ? 'bridge_credential_delivered' : 'credential_delivered');
  }
}
let nats: Awaited<ReturnType<typeof natsFixture>> | undefined;
let storage: Awaited<ReturnType<typeof database>> | undefined;
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
let lifecycle: Promise<void> | undefined, bridges: Promise<void> | undefined, events: Promise<void> | undefined;
let created = false;
const traces: Trace[] = [];
try {
  assert.equal((await run('kubectl', ['config', 'current-context'])).stdout.trim(), 'k3d-ocn');
  console.log(`Namespace ${namespace}; source ${(await run('git', ['rev-parse', 'HEAD'])).stdout.trim()}`);
  await k('create', 'namespace', namespace);
  created = true;
  const template = JSON.parse(await readFile('apps/computer/sandbox-template.json', 'utf8')) as { spec: { podTemplate: { spec: { containers: Array<{ image: string }> } } } };
  const base = template.spec.podTemplate.spec.containers[0]!.image;
  const image = `127.0.0.1:5001/opencrane/wake-latency:${namespace}`;
  // Add timestamp-only markers to the real bridge, without changing its decisions.
  let bridge = await readFile('apps/computer/src/bridge.ts', 'utf8');
  const marker = (stage: string) => `process.stdout.write(JSON.stringify({ latency: '${stage}', at: Date.now() }) + '\\n');`;
  bridge = bridge.replace('initialised = true;', `initialised = true; ${marker('codex_ready')}`)
    .replace("}).listen(8081, '0.0.0.0');", `}).listen(8081, '0.0.0.0', () => { ${marker('process_ready')} });`)
    .replace('reported = true;', `reported = true; ${marker('health_ready')}`)
    .replace('const id = `bridge-${++nextRpc}`;', `if (method === 'turn/start') { ${marker('turn_start')} }\n      const id = \`bridge-\${++nextRpc}\`;`)
    .replace('channel.notification(message);', `if (message['method'] === 'item/agentMessage/delta') { ${marker('first_token')} }\n    channel.notification(message);`);
  let channel = await readFile('apps/computer/src/channel.ts', 'utf8');
  channel = channel.replace("wss.on('connection', next => {", `wss.on('connection', next => { ${marker('bridge_connected')}`);
  await writeFile(`${directory}/bridge.ts`, bridge); await writeFile(`${directory}/channel.ts`, channel);
  await writeFile(`${directory}/Dockerfile`, `FROM ${base.replace('k3d-ocn-registry:5000', '127.0.0.1:5001')}\nCOPY bridge.ts channel.ts /app/src/\nRUN chmod 0444 /app/src/*.ts\n`);
  await run('docker', ['build', '-t', image, directory], { timeout: 120_000 });
  await run('docker', ['push', image], { timeout: 120_000 });
  const digest = (await run('docker', ['inspect', '--format={{index .RepoDigests 0}}', image])).stdout.trim();
  template.spec.podTemplate.spec.containers[0]!.image = digest.replace('127.0.0.1:5001', 'k3d-ocn-registry:5000');
  await writeFile(`${output}/image.json`, JSON.stringify({ base, digest, namespace, label }));
  // A separate labelled Pod is the entire model boundary; it has no provider keys or forwarding code.
  const stub = (await readFile('infra/dev-stack/model-stub.ts', 'utf8')).replace("43003, '127.0.0.1'", "3000, '0.0.0.0'");
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'model-stub' }, data: { 'stub.ts': stub } });
  await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'model-stub', labels: { app: 'opencrane-gateway' } }, spec: { automountServiceAccountToken: false,
    containers: [{ name: 'stub', image: base, command: ['node', '--experimental-strip-types', '/fixture/stub.ts'], volumeMounts: [{ name: 'fixture', mountPath: '/fixture' }] }], volumes: [{ name: 'fixture', configMap: { name: 'model-stub' } }] } });
  await apply({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'model-stub' }, spec: { selector: { app: 'opencrane-gateway' }, ports: [{ port: 3000, targetPort: 3000 }] } });
  await k('wait', '--for=condition=Ready', 'pod/model-stub', '--timeout=120s');
  const gatewayIp = await k('get', 'service/model-stub', '-o', 'jsonpath={.spec.clusterIP}');
  await k('create', 'configmap', 'computer-runtime', `--from-literal=gateway=http://${gatewayIp}:3000`);
  await apply(template);
  await k('apply', '-f', 'apps/computer/network-policy.json');
  await k('apply', '-f', 'infra/dev-stack/computer-pool.json');
  await run('kubectl', ['config', 'view', '--raw', '--minify', '--flatten', '-o', 'json']).then(result => writeFile(`${directory}/kubeconfig`, result.stdout, { mode: 0o600 }));
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://wake.test/' });
  const kube = new TimedKube(`${directory}/kubeconfig`, namespace, 'computer', '1Gi');
  nats = await natsFixture(); storage = await database('pg');
  const store = nats.store;
  const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('wake-measure', { level: 'silent' }));
  await runner.initialise(conversations);
  const keys = conversationKeys(`${directory}/keys`);
  const joined = { id: randomUUID(), commandId: randomUUID(), type: 'member.joined', subject: 'member-alice', silo: 'test', source: 'test', correlation: {}, time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'alice' }, data: { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member' } };
  assert.equal((await store.append({ event: joined, expectedSequence: 0 })).status, 'appended');
  const handlers = lifecycleHandlers(store);
  await handlers[0].handle(joined, storage.db);
  let assistant;
  for await (const row of store.subscribe(1, stop.signal)) { if (row.event.type === 'assistant.created') { assistant = row.event; break; } }
  assert(assistant);
  await handlers[1].handle(assistant, storage.db);
  const assistantId = field(assistant.data, 'assistantId'), subject = `computer-${assistantId}`;
  const computerId = field((await history(store, subject)).at(-1)!.event.data, 'computerId');
  let loggingUid: string | undefined;
  watch('pods', object => {
    const pod = value(object, 'object');
    if (value(pod, 'metadata', 'name') !== computerId || value(object, 'type') === 'DELETED') return;
    const uid = value(pod, 'metadata', 'uid');
    if (typeof uid !== 'string') return;
    const conditions = value(pod, 'status', 'conditions');
    if (Array.isArray(conditions) && conditions.some(c => value(c, 'type') === 'PodScheduled' && value(c, 'status') === 'True')) stamp('pod_scheduled');
    if (Array.isArray(conditions) && conditions.some(c => value(c, 'type') === 'Ready' && value(c, 'status') === 'True')) stamp('pod_ready');
    if (loggingUid === uid) return;
    loggingUid = uid;
    const logs = spawn('kubectl', ['--context=k3d-ocn', '-n', namespace, 'logs', '-f', computerId, '--pod-running-timeout=120s']); children.push(logs);
    let buffer = '';
    logs.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        const data: unknown = JSON.parse(line);
        const stage = value(data, 'latency'), at = value(data, 'at');
        if (typeof stage === 'string' && typeof at === 'number') stamp(stage, at);
      }
    });
  });
  watch('events', object => {
    const event = value(object, 'object');
    if (value(event, 'involvedObject', 'name') !== computerId) return;
    const reason = value(event, 'reason');
    if (reason === 'Pulled') stamp('image_ready');
    if (reason === 'Created') stamp('image_volume_ready');
    if (reason === 'Started') stamp('container_start');
  });
  events = (async () => {
    for await (const row of store.subscribe(1, stop.signal)) {
      if (row.event.type === 'computer.resumed') stamp('resume_command', Date.parse(row.event.time));
      if (row.event.type === 'agent.message_delta') stamp('first_token_committed', Date.parse(row.event.time));
    }
  })();
  const proxy = spawn('kubectl', ['--context=k3d-ocn', 'proxy', '--address=127.0.0.1', '--port=0']); children.push(proxy);
  let proxyOutput = ''; proxy.stdout.on('data', (chunk: Buffer) => { proxyOutput += chunk.toString(); });
  await until(() => /127\.0\.0\.1:(\d+)/u.test(proxyOutput), 'private proxy');
  const proxyUrl = `http://127.0.0.1:${/127\.0\.0\.1:(\d+)/u.exec(proxyOutput)![1]}`;
  lifecycle = watchComputers(store, kube, tokens, (id, token) => kube.credentials(id, token), 'test', 600_000, stop.signal);
  void lifecycle.catch(error => { console.error(error); stop.abort(); });
  await until(async () => (await history(store, subject)).at(-1)?.event.type === 'computer.ready', 'initial Ready');
  const conversationId = randomUUID(), context = { silo: 'test', memberId: 'alice' };
  keys.provision('test', conversationId);
  await chatCommand(store, keys, context, { id: randomUUID(), conversationId, assistantId });
  await runner.run(conversations);
  bridges = watchBridges({ store, keys, db: storage.db, silo: 'test' }, tokens, kube, proxyUrl, stop.signal);
  void bridges.catch(error => { console.error(error); stop.abort(); });
  for (let index = 0; index < 5; index++) {
    const rows = await history(store, subject), latest = rows.findLast(r => r.event.type === 'computer.ready')!.event;
    await suspendComputer(store, { assistantId, computerId, latest, ready: latest });
    await until(async () => (await kube.state(computerId))?.suspended === true && !(await kube.state(computerId))?.podUid, 'suspended and old Pod gone');
    await delay(500); // Settle deletion watches before arming the next sample.
    trace = {};
    const id = randomUUID();
    await chatCommand(store, keys, context, { id, conversationId, text: 'Say hello briefly.' });
    trace['message_posted'] = Date.parse((await chatHistory(store, 'test', conversationId)).find(r => r.event.id === id)!.event.time);
    await until(async () => (await chatHistory(store, 'test', conversationId)).some(r => r.event.type === 'agent.turn_completed' && field(r.event.data, 'turnId') === id), 'stub turn completed');
    await until(() => trace?.['first_token'] !== undefined, 'first-token marker');
    await until(async () => (await history(store, subject)).at(-1)?.event.type === 'computer.turn_closed', 'turn fence closed');
    for (const stage of ['message_posted', 'resume_command', 'running_patch', 'pod_scheduled', 'image_ready', 'image_volume_ready', 'container_start', 'process_ready', 'codex_ready', 'health_ready', 'pod_ready', 'credential_delivered', 'bridge_connected', 'turn_start', 'first_token', 'first_token_committed']) {
      assert(Number.isSafeInteger(trace[stage]), `Missing stage: ${stage}`);
    }
    traces.push(trace); console.log(`Sample ${index + 1}: ${JSON.stringify(trace)}`); trace = undefined;
    await writeFile(`${output}/samples.json`, JSON.stringify(traces, null, 2));
  }
  console.log(`PASS five stub wake turns; evidence ${output}/samples.json`);
} catch (error) {
  await writeFile(`${output}/failed-trace.json`, JSON.stringify({ namespace, trace, error: String(error) }, null, 2));
  throw error;
} finally {
  stop.abort();
  await Promise.allSettled([lifecycle, bridges, events]);
  for (const child of children) child.kill();
  await nats?.close(); await storage?.close();
  if (created) await k('delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=120s');
  await rm(directory, { recursive: true, force: true });
}
