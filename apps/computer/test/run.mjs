// Reuse S0.1b's real gateway/provider/probe and S0.3's disposable lab helpers.
import { resume } from './pvc.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { command, input, until } from '../../../spikes/s0-3-warm-pool/lab.mjs';
process.chdir(new URL('../../..', import.meta.url).pathname);
const ns = 'p21-computer', state = 'apps/computer/.state';
mkdirSync(state, { recursive: true });
const image = readFileSync(`${state}/image.txt`, 'utf8').trim();
assert.match(image, /^k3d-ocn-registry:5000\/opencrane\/computer(?:-candidate)?@sha256:[a-f0-9]{64}$/);
assert.equal(await command('kubectl', ['config', 'current-context']), 'k3d-ocn');
assert.equal(await command('kubectl', ['get', 'ns', ns, '--ignore-not-found']), '');
const k = (...args) => command('kubectl', ['-n', ns, ...args]);
const apply = obj => input('kubectl', ['-n', ns, 'apply', '-f', '-'], JSON.stringify(obj));
const exec = (pod, code, data = {}, container = pod === 'backend' ? 'services' : 'computer') => input('kubectl', ['-n', ns, 'exec', '-i', pod, '-c', container, '--', 'node', '--input-type=module', '-e', code], JSON.stringify(data));
const fixtureImage = 'k3d-ocn-registry:5000/opencrane/s035@sha256:6fe29bfc4455f19601bbca9e3cffa998fed57632484bb3a624a8da69beecee47';
const receipts = [];
const pass = (name, detail) => { receipts.push({ name, result: 'PASS', detail }); console.log(`PASS ${name}: ${detail}`); };
let driver, podName;
await apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } });
try {
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'fixtures' }, data: {
    'config.yaml': readFileSync('spikes/s0-1b-proxy-gvisor/gateway.yaml', 'utf8'),
    'services.mjs': readFileSync('spikes/s0-1b-proxy-gvisor/services.mjs', 'utf8').replace('/spike/probe.mjs', '/workspace/probe.mjs'),
  } });
  await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'backend', labels: { app: 'opencrane-gateway', server: 'test' } }, spec: {
    automountServiceAccountToken: false, terminationGracePeriodSeconds: 0,
    containers: [{ name: 'services', image: fixtureImage, command: ['node', '/spike/services.mjs'], volumeMounts: [{ name: 'config', mountPath: '/spike/services.mjs', subPath: 'services.mjs' }] },
      { name: 'gateway', image: 'ghcr.io/agentgateway/agentgateway@sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896', args: ['-f', '/config/config.yaml'], volumeMounts: [{ name: 'config', mountPath: '/config' }] }],
    volumes: [{ name: 'config', configMap: { name: 'fixtures' } }],
  } });
  await k('wait', '--for=condition=Ready', 'pod/backend', '--timeout=120s');
  const backend = JSON.parse(await k('get', 'pod/backend', '-o', 'json')).status.podIP;
  const policy = JSON.parse(readFileSync('apps/computer/network-policy.json'));
  await apply(policy);
  const template = JSON.parse(readFileSync('apps/computer/sandbox-template.json'));
  assert.equal(template.spec.podTemplate.spec.containers[0].image, image, 'test the tracked release digest');
  await apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'computer-runtime' }, data: { gateway: `http://${backend}:3000` } });
  await input('kubectl', ['-n', ns, 'apply', '-f', '-'], readFileSync('apps/computer/sandbox-template.json'));
  await apply({ apiVersion: template.apiVersion, kind: 'SandboxWarmPool', metadata: { name: 'computer' }, spec: { replicas: 0, sandboxTemplateRef: { name: 'computer' } } });
  const started = performance.now();
  await apply({ apiVersion: template.apiVersion, kind: 'SandboxClaim', metadata: { name: 'computer' }, spec: { warmPoolRef: { name: 'computer' } } });
  podName = await until(async () => {
    const claim = JSON.parse(await k('get', 'sandboxclaim/computer', '-o', 'json'));
    return claim.status?.sandbox?.name;
  }, 'claim creates Sandbox');
  await until(async () => (await k('get', 'pod', podName, '--ignore-not-found')).length, 'Pod created');
  await k('wait', '--for=condition=Ready', `pod/${podName}`, '--timeout=180s');
  const readyMs = Math.round(performance.now() - started);
  pass('Pod ready', `${readyMs} ms from claim apply, fresh Pod; local registry/layers may be cached`);
  for (const phase of ['fresh', 'resumed']) {
  if (phase === 'resumed') {
    driver?.kill();
    podName = await resume({ k, apply, exec, template, pass });
    await k('label', 'pod/backend', 'app=opencrane-gateway', '--overwrite');
  }
  const probeSource = readFileSync('spikes/s0-1b-proxy-gvisor/probe.mjs', 'utf8').replace('/run/codex/exec.sock', '/run/executor/exec.sock');
  await exec(podName, `import {writeFileSync} from 'node:fs';writeFileSync('/workspace/probe.mjs',${JSON.stringify(probeSource)},{mode:0o644});`);
  const pod = JSON.parse(await k('get', 'pod', podName, '-o', 'json'));
  const pods = JSON.parse(await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'pods', '-o', 'json']));
  const runtime = await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'inspectp', pods.items.find(p => p.metadata.uid === pod.metadata.uid).id]);
  assert.match(runtime, /io.containerd.runsc.v1/);
  assert.equal(pod.spec.containers[0].resources.limits.memory, '512Mi');
  pass('runtime', 'CRI confirms gVisor, 512 MiB limit');
  assert.deepEqual(JSON.parse(await exec(podName, "console.log(await fetch('http://127.0.0.1:8081/health').then(r=>r.text()))")), { ready: true, bridge: 'stub' });
  assert.match(await k('logs', podName), /"report":"ready"/);
  pass('health', 'ready endpoint and ready report after Codex initialisation');
  await exec(podName, `import assert from 'node:assert/strict';import {statSync,realpathSync} from 'node:fs';assert.equal(statSync('/home/agent').uid,0);assert.equal(statSync('/home/agent').mode&511,493);for(const [name,uid,mode] of [['codex',1000,448],['workspace',1001,493],['profile',1002,448]]){const st=statSync('/home/agent/'+name);assert.equal(st.uid,uid);assert.equal(st.mode&511,mode)}assert.equal(realpathSync('/home/codex/.codex'),'/home/agent/codex');`);
  for (const path of ['/home/codex', '/run/codex', '/home/desktop']) {
    const mount = pod.spec.containers[0].volumeMounts.find(m => m.mountPath === path);
    assert.equal(pod.spec.volumes.find(v => v.name === mount.name).emptyDir.medium, 'Memory');
  }
  for (const uid of [1000, 1001, 1002]) {
    await exec(podName, `import assert from 'node:assert/strict';import {writeFileSync,renameSync} from 'node:fs';process.setgroups([]);process.setgid(${uid});process.setuid(${uid});assert.throws(()=>writeFileSync('/home/agent/attack','x'),{code:'EACCES'});assert.throws(()=>renameSync('/home/agent/workspace','/home/agent/stolen'),{code:'EACCES'});for(const path of ['/usr/local/bin/tool-user','/usr/local/bin/node','/usr/bin/setpriv','/app/src/entrypoint.ts','/app/src/desktop.ts'])assert.throws(()=>writeFileSync(path,'attack'));`);
  }
  pass('storage', 'per-UID persistent directory ownership/modes and separate memory-backed credential mounts');
  const admin = async (route, value) => JSON.parse(await exec('backend', `import {body,call} from '/spike/common.mjs';console.log((await call('http://127.0.0.1:9001/${route}',JSON.parse(await body(process.stdin)))).text)`, value));
  const control = (route, value) => exec(podName, `import {request} from 'node:http';process.setgroups([]);process.setgid(1000);process.setuid(1000);const r=request({socketPath:'/run/codex/control.sock',path:'/${route}',method:'POST'},r=>r.pipe(process.stdout));r.end(${JSON.stringify(JSON.stringify(value))});`);
  await exec('backend', "(await import('node:fs')).writeFileSync('/tmp/model.jsonl','')");
  await exec(podName, `import {writeFileSync,chownSync} from 'node:fs';writeFileSync('/workspace/targets.json',JSON.stringify({gateway:'http://${backend}:3000'}),{mode:0o644});for(const p of ['private','tokens.json']){writeFileSync('/home/codex/'+p,'test canary',{mode:0o600});chownSync('/home/codex/'+p,1000,1000);}`);
  driver = spawn('kubectl', ['-n', ns, 'exec', '-i', podName, '--', 'node', '-e', "process.setgroups([]);process.setgid(1000);process.setuid(1000);const s=require('net').connect('/run/codex/app.sock');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1))"]);
  const messages = []; let sequence = 0;
  driver.stderr.on('data', data => writeFileSync(`${state}/driver.stderr`, data, { flag: 'a' }));
  createInterface({ input: driver.stdout }).on('line', line => messages.push(JSON.parse(line)));
  const rpc = async (method, params) => {
    const id = ++sequence; driver.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const message = await until(() => messages.find(m => m.id === id), method);
    assert.equal(message.error, undefined); return message.result;
  };
  const thread = (await rpc('thread/start', { cwd: '/workspace' })).thread.id;
  await control('grant', await admin('issue', { thread, ttl: 120000 }));
  await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'ISOLATION: run the probe.', text_elements: [] }] });
  const end = await until(() => messages.find(m => m.method === 'turn/completed'), 'probe turn', 120000);
  assert.equal(end.params.turn.status, 'completed');
  assert.match(await exec('backend', "console.log(require('fs').readFileSync('/tmp/model.jsonl','utf8'))".replace("require('fs')", "(await import('node:fs'))")), /ISOLATION_PASS/);
  await control('drop', { thread });
  const localCall = value => exec(podName, `import {readFileSync} from 'node:fs';process.setgroups([]);process.setgid(1000);process.setuid(1000);console.log((await fetch('http://127.0.0.1:8080/v1/responses',{method:'POST',headers:{authorization:'Bearer '+readFileSync('/home/codex/caller','utf8'),'session-id':${JSON.stringify(thread)}},body:'{}'})).status)`, value);
  assert.equal(await localCall({}), '403');
  assert.match(await control('grant', {thread,computer:'test',token:'test',expires:Date.now()+240000}), /bad input/);
  const invalidGrant = await admin('issue', {thread: 'another-thread',ttl:120000});
  await control('grant', {...invalidGrant,thread});
  assert.equal(await localCall({}), '403');
  await control('drop', {thread});
  pass('proxy grants', 'dropped thread, overlong grant and cross-thread token refused; unauthenticated caller refused below');
  pass('executor isolation', 'real Codex-requested native exec-server command: UID 1001, seccomp EPERM for proxy/gateway/IPv6, private files and process tokens denied');
  assert.equal(await exec(podName, "console.log((await fetch('http://127.0.0.1:8080/v1/responses',{method:'POST',body:'{}'})).status)"), '401');
  const check = readFileSync('apps/computer/test/desktop.mjs', 'utf8');
  assert.match(await input('kubectl', ['-n', ns, 'exec', '-i', podName, '--', 'setpriv', '--no-new-privs', 'node', '--input-type=module'], check), /DESKTOP_PASS/);
  pass('desktop', 'UID 1002 + no_new_privs, private home denied; sandbox-enabled Playwright launches real Chromium and renders text');
  assert.match(await input('kubectl', ['-n', ns, 'exec', '-i', podName, '--', 'python3'], readFileSync('apps/computer/test/document.py')), /DOCUMENT_PASS/);
  pass('documents', 'MarkItDown converts generated sample PDF and Office DOCX/XLSX/PPTX without network');
  const probe = `try{console.log((await fetch('http://${backend}:9003/health',{signal:AbortSignal.timeout(1500)})).status)}catch{console.log('BLOCKED')}`;
  assert.equal(await exec(podName, probe), 'BLOCKED');
  assert.equal(await exec(podName, `console.log((await fetch('http://${backend}:3000/v1/responses',{method:'POST',body:'{}'})).status)`), '403');
  const ingress = `try{console.log((await fetch('http://${pod.status.podIP}:8081/health',{signal:AbortSignal.timeout(1500)})).status)}catch{console.log('BLOCKED')}`;
  assert.equal(await exec('backend', ingress), 'BLOCKED');
  await k('label', 'pod/backend', 'app=opencrane-server', '--overwrite');
  await until(async () => (await exec('backend', ingress)) === '200', 'server ingress allowed');
  await k('delete', 'networkpolicy/computer');
  await until(async () => (await exec(podName, probe)) === '200', 'policy removal positive control');
  await apply(policy);
  await until(async () => (await exec(podName, probe)) === 'BLOCKED', 'policy restored');
  pass('network policy', 'gateway-only TCP 3000 egress and server-only health ingress; removed-policy positive control');
  pass(`${phase} image checks`, 'all isolation, proxy, desktop, document and network assertions passed');
  }
} catch (error) { receipts.push({ name: 'run', result: 'FAIL', detail: error.message }); throw error; }
finally {
  driver?.kill();
  if (podName) await k('logs', podName).then(log => writeFileSync(`${state}/computer.log`, log)).catch(error => console.error(error.message));
  await command('kubectl', ['delete', 'ns', ns, '--wait=true', '--timeout=120s']);
  pass('cleanup', `${ns} deleted`);
  writeFileSync(`${state}/checks.json`, JSON.stringify({ date: new Date().toISOString(), source: await command('git', ['rev-parse', 'HEAD']), image, receipts }, null, 2) + '\n');
}
