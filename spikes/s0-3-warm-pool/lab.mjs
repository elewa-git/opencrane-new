import assert from 'node:assert/strict';
import { spawn, execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
export { sleep };
const execFile = promisify(execCallback);
export const command = async (bin, args) => (await execFile(bin, args, { maxBuffer: 20_000_000 })).stdout.trim();
export const input = (bin, args, data = '') => new Promise((resolve, reject) => {
  const child = spawn(bin, args); let out = ''; let err = '';
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${bin}: ${err}`)));
  child.stdin.end(data);
});
export async function until(fn, name, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(100); }
  throw new Error(`timeout: ${name}`);
}
export async function lab(ns, state) {
  mkdirSync(state, { recursive: true });
  assert.equal(await command('kubectl', ['config', 'current-context']), 'k3d-ocn');
  assert.equal(await command('kubectl', ['get', 'ns', ns, '--ignore-not-found']), '', 'refuse existing namespace');
  const k = (...args) => command('kubectl', ['-n', ns, ...args]);
  const apply = object => input('kubectl', ['apply', '-f', '-'], JSON.stringify({ ...object, metadata: { ...object.metadata, namespace: ns } }));
  const exec = (pod, code, data = {}, container = pod === 'backend' ? 'services' : 'computer') => input('kubectl', ['-n', ns, 'exec', '-i', pod, '-c', container, '--', 'node', '--input-type=module', '-e', code], JSON.stringify(data));
  const admin = (path, data = {}) => exec('backend', `import {body,call} from '/spike/common.mjs';console.log((await call('http://127.0.0.1:9001/${path}',JSON.parse(await body(process.stdin)))).text)`, data).then(JSON.parse);
  const records = async () => JSON.parse(await exec('backend', `import {readFileSync} from 'node:fs';console.log(JSON.stringify(readFileSync('/tmp/model.jsonl','utf8').trim().split(String.fromCharCode(10)).map(JSON.parse)))`));
  const grant = (pod, value) => input('kubectl', ['-n', ns, 'exec', '-i', pod, '--', 'node', '/spike/driver.mjs', 'grant'], JSON.stringify(value));
  const api = 'extensions.agents.x-k8s.io/v1beta1';
  const image = readFileSync('spikes/s0-5-live-view/.state/image.txt', 'utf8').trim(); assert.match(image, /@sha256:/);
  const receipts = [];
  const pass = (name, detail, result = 'PASS') => { receipts.push({ name, result, detail }); console.log(`${result} ${name}: ${detail}`); };
  await apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
  const clean = async () => {
    try { writeFileSync(`${state}/resources.json`, await k('get', 'pods,sandboxes,sandboxclaims,sandboxwarmpools', '-o', 'json')); writeFileSync(`${state}/events.txt`, await k('get', 'events', '--sort-by=.metadata.creationTimestamp')); for (const p of JSON.parse(await k('get', 'pods', '-l', 'app=computer', '-o', 'json')).items) { writeFileSync(`${state}/${p.metadata.name}.log`, await k('logs', p.metadata.name)); } } catch {}
    try { writeFileSync(`${state}/gateway.log`, await k('logs', 'backend', '-c', 'gateway')); } catch {}
    await command('kubectl', ['delete', 'ns', ns, '--wait=true', '--timeout=120s']);
    pass('cleanup', `${ns} deleted`);
    writeFileSync(`${state}/results.json`, JSON.stringify({ date: new Date().toISOString(), base: await command('git', ['rev-parse', 'HEAD']), image, receipts }, null, 2) + '\n');
  };
  try {
    const config = readFileSync('spikes/s0-1b-proxy-gvisor/gateway.yaml', 'utf8') + `\n  - name: local-site\n    matches:\n      - path:\n          pathPrefix: /site\n    policies:\n      extAuthz:\n        host: 127.0.0.1:9005\n        includeRequestHeaders: [x-desktop-token]\n        protocol:\n          http:\n            path: '"/authorize"'\n        failureMode:\n          denyWithStatus: 503\n      transformations:\n        request:\n          replace: '{"cookie": ("cookie" in request.headers) ? request.headers["cookie"] : ""}'\n    backends:\n      - host: 127.0.0.1:9004\n`;
    await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'gateway' }, data: { 'config.yaml': config } });
    await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'backend', labels: { app: 'backend' } }, spec: {
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 0,
      containers: [{ name: 'services', image, command: ['node', '/spike/services.mjs'], securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } },
        { name: 'gateway', image: 'ghcr.io/agentgateway/agentgateway@sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896', args: ['-f', '/config/config.yaml'], volumeMounts: [{ name: 'config', mountPath: '/config' }] }],
      volumes: [{ name: 'config', configMap: { name: 'gateway' } }],
    } });
    await k('wait', '--for=condition=Ready', 'pod/backend', '--timeout=120s');
    const backend = JSON.parse(await k('get', 'pod/backend', '-o', 'json')).status.podIP;
    await exec('backend', `import {spawn} from 'node:child_process';const c=spawn('node',['/lifecycle/site.mjs'],{detached:true,stdio:'ignore'});c.unref();`);
    const policy = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'computer' }, spec: {
      podSelector: { matchLabels: { app: 'computer' } }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [{ podSelector: { matchLabels: { app: 'backend' } } }], ports: [{ protocol: 'TCP', port: 6901 }] }],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'backend' } } }], ports: [{ protocol: 'TCP', port: 3000 }] }],
    } }; await apply(policy);
    const podSpec = persistent => ({ runtimeClassName: 'gvisor', automountServiceAccountToken: false, terminationGracePeriodSeconds: 1,
      containers: [{ name: 'computer', image, env: [{ name: 'GATEWAY', value: `http://${backend}:3000` }],
        securityContext: { capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE'] } },
        volumeMounts: [{ name: 'home', mountPath: '/home/agent' }],
        readinessProbe: { exec: { command: ['node', '-e', "require('fs').accessSync('/home/codex/caller')"] }, periodSeconds: 1 },
      }], volumes: [{ name: 'home', ...(persistent ? { persistentVolumeClaim: { claimName: 'disk' } } : { emptyDir: {} }) }],
    });
    await apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'disk' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } });
    const computer = async name => {
      await apply({ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name }, spec: { podTemplate: { metadata: { labels: { app: 'computer' } }, spec: podSpec(true) } } });
      await until(async () => (await k('get', `pod/${name}`, '--ignore-not-found')).length, 'Pod exists');
      await k('wait', '--for=condition=Ready', `pod/${name}`, '--timeout=120s');
      return JSON.parse(await k('get', `pod/${name}`, '-o', 'json'));
    };
    return { ns, state, k, apply, exec, admin, records, grant, api, image, backend, podSpec, computer, clean, pass, receipts };
  } catch (e) { await clean(); throw e; }
}
export async function driver(lab, pod) {
  const messages = []; let sequence = 0;
  const child = spawn('kubectl', ['-n', lab.ns, 'exec', '-i', pod, '--', 'node', '/spike/driver.mjs']);
  child.stderr.on('data', data => writeFileSync(`${lab.state}/driver.stderr`, data, { flag: 'a' }));
  createInterface({ input: child.stdout }).on('line', line => messages.push(JSON.parse(line)));
  await until(() => { assert.equal(child.exitCode, null, 'Codex driver exited; see driver.stderr'); return messages.some(m => m.driver === 'ready'); }, 'Codex ready');
  const rpc = async (method, params) => {
    const tag = `rpc-${++sequence}`; child.stdin.write(JSON.stringify({ tag, method, params }) + '\n');
    return (await until(() => messages.find(m => m.driver === tag), method)).result;
  };
  const turn = async (id, text) => {
    const start = messages.length;
    await lab.grant(pod, await lab.admin('issue', { thread: id, ttl: 120000 }));
    await rpc('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }] });
    const end = await until(() => messages.slice(start).find(m => m.method === 'turn/completed' && m.params.threadId === id), 'completed turn');
    assert.equal(end.params.turn.status, 'completed');
  };
  return { child, messages, rpc, turn };
}
