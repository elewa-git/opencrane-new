import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sleep } from './common.mjs';
const execFile = promisify(execFileCallback);
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const real = process.argv[2] === '--real';
if (real && (!process.argv[3] || !process.argv[4])) throw new Error('usage: node run.mjs --real /absolute/key-file model-id');
const ns = 's01b-proxy';
const state = '.state'; mkdirSync(state, { recursive: true, mode: 0o700 });
const receipts = [];
const pass = (name, detail) => { receipts.push({ name, result: 'PASS', detail }); console.log(`PASS ${name}: ${detail}`); };
const command = async (bin, args, options = {}) => (await execFile(bin, args, { maxBuffer: 20_000_000, ...options })).stdout.trim();
const k = (...args) => command('kubectl', ['-n', ns, ...args]);
const inputCommand = (bin, args, input) => new Promise((resolve, reject) => {
  const child = spawn(bin, args); let out = ''; let err = '';
  child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${bin} failed: ${err}`)));
  child.stdin.end(input);
});
const apply = object => inputCommand('kubectl', ['apply', '-f', '-'], JSON.stringify(object));
const exec = (pod, container, code, input = {}) => inputCommand('kubectl', ['-n', ns, 'exec', '-i', pod, '-c', container, '--', 'node', '--input-type=module', '-e', code], JSON.stringify(input));
const admin = (path, data) => exec('backend', 'services', `import {body,call} from '/spike/common.mjs'; console.log((await call('http://127.0.0.1:9001/${path}', JSON.parse(await body(process.stdin)))).text);`, data).then(JSON.parse);
const gatewayCall = (thread, grant) => exec('backend', 'services', `import {body,call} from '/spike/common.mjs'; const i=JSON.parse(await body(process.stdin)); console.log(JSON.stringify(await call('http://127.0.0.1:3000/v1/responses', {input:[]}, {'session-id':i.thread,authorization:'Bearer '+i.grant.computer,'x-turn-token':i.grant.token})));`, { thread, grant }).then(JSON.parse);
const grantProxy = grant => inputCommand('kubectl', ['-n', ns, 'exec', '-i', 'computer', '--', 'node', '/spike/driver.mjs', 'grant'], JSON.stringify(grant));
const backendLog = async name => {
  const result = await exec('backend', 'services', `import {readFileSync} from 'node:fs'; try { process.stdout.write(readFileSync('/tmp/${name}.jsonl')); } catch(e) { if(e.code!=='ENOENT') throw e; }`);
  return result ? result.split('\n').map(JSON.parse) : [];
};
async function until(fn, description, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error(`timeout: ${description}`);
}
let driver;
let created = false;
try {
  assert.equal(await command('kubectl', ['config', 'current-context']), 'k3d-ocn');
  const exists = await command('kubectl', ['get', 'namespace', ns, '--ignore-not-found']);
  assert.equal(exists, '', `namespace ${ns} already exists; inspect it before removing`);
  for (const file of ['driver.jsonl', 'codex.stderr']) writeFileSync(`${state}/${file}`, '');
  await command('gcc', ['-static', '-O2', '-Wall', '-Werror', 'tool-user.c', '-o', '.state/tool-user']);
  await command('docker', ['build', '-t', '127.0.0.1:5001/opencrane/s01b:spike', '.']);
  await command('docker', ['push', '127.0.0.1:5001/opencrane/s01b:spike']);
  const pushedImage = JSON.parse(await command('docker', ['inspect', '127.0.0.1:5001/opencrane/s01b:spike']))[0].RepoDigests.find(value => value.startsWith('127.0.0.1:5001/'));
  const image = pushedImage.replace('127.0.0.1:5001/', 'k3d-ocn-registry:5000/');
  assert.match(image, /@sha256:/); writeFileSync(`${state}/image.txt`, image + '\n');
  await apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } }); created = true;
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'gateway', namespace: ns }, data: { 'config.yaml': readFileSync('gateway.yaml', 'utf8') } });
  const gatewayImage = 'ghcr.io/agentgateway/agentgateway@sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896';
  if (real) {
    assert.equal(statSync(process.argv[3]).mode & 0o077, 0, 'key file must be private');
    await apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'provider', namespace: ns }, data: { openai: readFileSync(process.argv[3]).toString('base64') } });
  }
  await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'backend', namespace: ns, labels: { app: 'backend' } }, spec: {
    automountServiceAccountToken: false, terminationGracePeriodSeconds: 0,
    containers: [
      { name: 'services', image, ...(real ? { env: [{ name: 'REAL_MODEL', value: process.argv[4] }], volumeMounts: [{ name: 'key', mountPath: '/key', readOnly: true }] } : {}), command: ['node', '/spike/services.mjs'], securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } },
      { name: 'gateway', image: gatewayImage, args: ['-f', '/config/config.yaml'], volumeMounts: [{ name: 'config', mountPath: '/config' }], securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } },
    ], volumes: [{ name: 'config', configMap: { name: 'gateway' } }, ...(real ? [{ name: 'key', secret: { secretName: 'provider', defaultMode: 0o444 } }] : [])],
  } });
  await k('wait', '--for=condition=Ready', 'pod/backend', '--timeout=120s');
  const backend = JSON.parse(await k('get', 'pod/backend', '-o', 'json'));
  const gateway = `http://${backend.status.podIP}:3000`;
  const policy = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'computer-egress', namespace: ns }, spec: {
    podSelector: { matchLabels: { app: 'computer' } }, policyTypes: ['Ingress', 'Egress'], ingress: [],
    egress: [{ to: [{ podSelector: { matchLabels: { app: 'backend' } } }], ports: [{ protocol: 'TCP', port: 3000 }] }],
  } };
  await apply(policy);
  await apply({ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name: 'computer', namespace: ns }, spec: {
    podTemplate: { metadata: { labels: { app: 'computer' } }, spec: {
      runtimeClassName: 'gvisor', automountServiceAccountToken: false, terminationGracePeriodSeconds: 0,
      containers: [{ name: 'computer', image, env: [{ name: 'GATEWAY', value: gateway }, { name: 'MODEL', value: real ? process.argv[4] : 'stub-model' }],
        securityContext: { capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE'] } } }],
    } },
  } });
  await until(async () => (await k('get', 'pod/computer', '--ignore-not-found')).includes('computer'), 'Sandbox creates Pod');
  await k('wait', '--for=condition=Ready', 'pod/computer', '--timeout=120s');
  await until(async () => (await k('logs', 'computer')).includes('proxy ready'), 'proxy ready');
  const pod = JSON.parse(await k('get', 'pod/computer', '-o', 'json'));
  assert.equal(pod.spec.runtimeClassName, 'gvisor'); assert.equal(pod.metadata.ownerReferences[0].kind, 'Sandbox');
  writeFileSync(`${state}/pod.json`, JSON.stringify(pod, null, 2));
  writeFileSync(`${state}/runtimeclass.json`, await command('kubectl', ['get', 'runtimeclass', 'gvisor', '-o', 'json']));
  const sandboxes = JSON.parse(await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'pods', '-o', 'json']));
  const sandbox = sandboxes.items.find(item => item.metadata.uid === pod.metadata.uid);
  assert.ok(sandbox);
  const runtime = JSON.parse(await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'inspectp', sandbox.id]));
  writeFileSync(`${state}/runtime.json`, JSON.stringify(runtime, null, 2));
  assert.match(JSON.stringify(runtime), /runsc/);
  pass('runtime', `Sandbox-owned Pod ${pod.metadata.uid}, runtimeClassName=gvisor, image=${image}`);
  // Positive control: UID 1000 can reach gateway, but cannot bypass NetworkPolicy to model.
  const network = await exec('computer', 'computer', `import {connect} from 'node:net'; process.setgroups([]);process.setgid(1000);process.setuid(1000); const check=(port)=>new Promise(r=>{const s=connect({host:'${backend.status.podIP}',port});s.setTimeout(1500,()=>{s.destroy();r('timeout')});s.on('connect',()=>{s.destroy();r('connected')});s.on('error',e=>r(e.code));});console.log(JSON.stringify({gateway:await check(3000),model:await check(9003)}));`);
  assert.equal(JSON.parse(network).gateway, 'connected');
  assert.ok(['timeout', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(JSON.parse(network).model));
  await k('delete', 'networkpolicy/computer-egress');
  await until(async () => (await exec('computer', 'computer', `const r=await fetch('http://${backend.status.podIP}:9003/health', {signal:AbortSignal.timeout(1000)}).catch(()=>null);console.log(r?.status);`)) === '200', 'model reachable with policy removed');
  await apply(policy);
  await until(async () => (await exec('computer', 'computer', `const r=await fetch('http://${backend.status.podIP}:9003/health', {signal:AbortSignal.timeout(1000)}).catch(()=>null);console.log(r===null);`)) === 'true', 'model blocked after policy restored');
  pass('NetworkPolicy', network);
  const callerCheck = await exec('computer', 'computer', `import {call} from '/spike/common.mjs'; console.log((await call('http://127.0.0.1:8080/v1/responses',{}, {'session-id':'forged'})).status);`);
  assert.equal(callerCheck, '401'); pass('caller authentication', 'missing caller capability returns HTTP 401');
  const messages = [];
  driver = spawn('kubectl', ['-n', ns, 'exec', '-i', 'computer', '--', 'node', '/spike/driver.mjs']);
  driver.stderr.on('data', chunk => writeFileSync(`${state}/codex.stderr`, chunk, { flag: 'a' }));
  createInterface({ input: driver.stdout }).on('line', line => {
    writeFileSync(`${state}/driver.jsonl`, line + '\n', { flag: 'a' }); messages.push(JSON.parse(line));
  });
  await until(() => messages.find(message => message.driver === 'ready'), 'Codex initialize');
  let sequence = 0;
  async function rpc(method, params) {
    const tag = `rpc-${++sequence}`;
    driver.stdin.write(JSON.stringify({ tag, method, params }) + '\n');
    return (await until(() => messages.find(message => message.driver === tag), method)).result;
  }
  const thread = async () => (await rpc('thread/start', { cwd: '/workspace' })).thread.id;
  const start = (id, text) => rpc('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }] });
  if (real) {
    const id = await thread(); await grantProxy(await admin('issue', { thread: id, ttl: 120000 }));
    await start(id, 'Reply with the word hello. Do not use tools.');
    const completed = await until(() => messages.find(m => m.method === 'turn/completed' && m.params.threadId === id), 'real model turn', 90000);
    assert.equal(completed.params.turn.status, 'completed');
    assert.ok(messages.some(m => m.method === 'item/agentMessage/delta'));
    assert.equal((await backendLog('model')).length, 1);
    pass('real model', 'one bounded request, streamed delta and completed turn through gVisor proxy and gateway');
  } else {
  const a = await thread(); const b = await thread();
  const ga = await admin('issue', { thread: a, ttl: 120000 }); const gb = await admin('issue', { thread: b, ttl: 120000 });
  await grantProxy(ga); await grantProxy(gb);
  await start(a, 'ISOLATION: execute the isolation probe then reply.');
  await start(b, 'Say hello.');
  for (const id of [a, b]) {
    const completed = await until(() => messages.find(m => m.method === 'turn/completed' && m.params.threadId === id), `completed ${id}`);
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed));
    assert.ok(messages.filter(m => m.method === 'item/agentMessage/delta' && m.params.threadId === id).length >= 3);
  }
  const model = await backendLog('model');
  const toolOutput = model.flatMap(record => record.body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output).join('\n');
  assert.match(toolOutput, /ISOLATION_PASS/);
  assert.ok(model.some(record => record.thread === a)); assert.ok(model.some(record => record.thread === b));
  for (const record of model) {
    assert.equal(record.headers.authorization, undefined); assert.equal(record.headers['x-turn-token'], undefined);
  }
  const decisions = await backendLog('decisions');
  const aHash = decisions.find(d => d.thread === a && d.reason === 'allow').tokenHash;
  const bHash = decisions.find(d => d.thread === b && d.reason === 'allow').tokenHash;
  assert.notEqual(aHash, bHash);
  pass('1 streaming', `two concurrent threads, >=3 deltas each, completed; ${model.length} provider requests recorded without credentials`);
  pass('2 tool isolation', toolOutput.match(/ISOLATION_PASS[^\n]*/)[0]);
  const before = (await backendLog('model')).length;
  const dropped = await exec('computer', 'computer', `import {readFileSync} from 'node:fs';import {call} from '/spike/common.mjs';console.log((await call('http://127.0.0.1:8080/v1/responses',{}, {'session-id':'${a}',authorization:'Bearer '+readFileSync('/home/codex/caller','utf8')})).status);`);
  assert.equal(dropped, '403');
  assert.equal((await gatewayCall(b, ga)).status, 403);
  const short = await admin('issue', { thread: 'expiry', ttl: 100 }); await sleep(150);
  assert.equal((await gatewayCall('expiry', short)).status, 403);
  await grantProxy(short);
  const expiredLocal = await exec('computer', 'computer', `import {readFileSync} from 'node:fs';import {call} from '/spike/common.mjs';console.log((await call('http://127.0.0.1:8080/v1/responses',{}, {'session-id':'expiry',authorization:'Bearer '+readFileSync('/home/codex/caller','utf8')})).status);`);
  assert.equal(expiredLocal, '403');
  assert.equal((await gatewayCall(a, { ...ga, token: 'forged' })).status, 403);
  await admin('revoke', { token: ga.token }); assert.equal((await gatewayCall(a, ga)).status, 403);
  assert.equal((await backendLog('model')).length, before);
  const denials = await backendLog('decisions');
  const evidence = JSON.stringify({ messages, model: await backendLog('model'), decisions: denials });
  for (const value of [ga.token, gb.token, ga.computer, short.token]) assert.ok(!evidence.includes(value), 'token leaked into evidence');
  for (const reason of ['thread mismatch', 'expired', 'unknown token']) assert.ok(denials.some(d => d.reason === reason));
  pass('3 thread tokens', `distinct token hashes ${aHash}/${bHash}; cross-thread, expiry, forged and revoked tokens denied at real gateway`);
  const crash = await thread(); const gc = await admin('issue', { thread: crash, ttl: 120000 }); await grantProxy(gc);
  await start(crash, 'KILL_ME: stream until the Pod is killed.');
  await until(async () => (await backendLog('held')).find(record => record.thread === crash), 'provider receives held request');
  await until(() => messages.find(m => m.method === 'item/agentMessage/delta' && m.params.threadId === crash), 'in-flight delta');
  assert.ok(!messages.some(m => m.method === 'turn/completed' && m.params.threadId === crash));
  await k('delete', 'pod/computer', '--force', '--grace-period=0', '--wait=true');
  assert.ok((await backendLog('model')).some(record => record.thread === crash));
  const access = await until(async () => { const logs = await k('logs', 'backend', '-c', 'gateway'); return logs.includes(crash) && logs; }, 'gateway crash receipt');
  writeFileSync(`${state}/gateway.log`, access);
  pass('4 killed mid-turn', `Pod ${pod.metadata.uid} force-deleted after provider receipt and delta; external model and gateway logs retain thread ${crash}; no completion before kill`);
  }
} catch (error) {
  console.error(error.stack); receipts.push({ result: 'FAIL', detail: error.message }); process.exitCode = 1;
} finally {
  driver?.kill();
  if (created) {
    for (const name of ['model', 'decisions', 'held']) {
      try { writeFileSync(`${state}/${name}.jsonl`, (await backendLog(name)).map(r => JSON.stringify(r)).join('\n') + '\n'); } catch (error) { console.error(`collect ${name}: ${error.message}`); }
    }
    for (const [pod, container] of [['computer', 'computer'], ['backend', 'gateway'], ['backend', 'services']]) {
      try { writeFileSync(`${state}/${container}.log`, await k('logs', pod, '-c', container)); } catch (error) { console.error(`collect ${container}: ${error.message}`); }
    }
    await command('kubectl', ['delete', 'namespace', ns, '--wait=true', '--timeout=90s']);
    pass('cleanup', `namespace ${ns} deleted`);
  }
  writeFileSync(`${state}/results.json`, JSON.stringify(receipts, null, 2) + '\n');
}
