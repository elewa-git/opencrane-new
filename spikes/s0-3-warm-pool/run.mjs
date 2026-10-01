import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { lab, driver, until, command, input } from './lab.mjs';
process.chdir(new URL('../..', import.meta.url).pathname);
const l = await lab('s03-warm', 'spikes/s0-3-warm-pool/.state');
let d;
try {
  await l.apply({ apiVersion: l.api, kind: 'SandboxTemplate', metadata: { name: 'neutral' }, spec: { volumeClaimTemplatesPolicy: 'Allowed',
    podTemplate: { metadata: { labels: { app: 'computer' } }, spec: l.podSpec(false) },
  } });
  await l.apply({ apiVersion: l.api, kind: 'SandboxWarmPool', metadata: { name: 'pool' }, spec: { replicas: 1, sandboxTemplateRef: { name: 'neutral' } } });
  const claims = [];
  for (let i = 0; i < 10; i++) {
    const warm = await until(async () => {
      const pods = JSON.parse(await l.k('get', 'pods', '-l', 'app=computer', '-o', 'json')).items;
      return pods.find(p => p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
    }, 'warm Pod');
    assert.equal(warm.metadata.labels['sandbox.users.io/computer'], undefined);
    const start = performance.now();
    await l.apply({ apiVersion: l.api, kind: 'SandboxClaim', metadata: { name: `claim-${i}` }, spec: {
      warmPoolRef: { name: 'pool' }, additionalPodMetadata: { labels: { 'sandbox.users.io/computer': `computer-${i}` } },
    } });
    const name = await until(async () => {
      const claim = JSON.parse(await l.k('get', 'sandboxclaim', `claim-${i}`, '-o', 'json'));
      return claim.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') && claim.status.sandbox.name;
    }, 'claim ready');
    const bound = await until(async () => {
      const pod = JSON.parse(await l.k('get', 'pod', name, '-o', 'json'));
      return pod.metadata.labels['sandbox.users.io/computer'] === `computer-${i}` && pod;
    }, 'computer binding');
    assert.equal(bound.metadata.uid, warm.metadata.uid, 'claimed pre-existing Pod');
    claims.push(Math.round(performance.now() - start));
    if (i === 0) {
      await assert.rejects(l.k('patch', 'pod', name, '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/spec/volumes/0', value: { name: 'home', persistentVolumeClaim: { claimName: 'disk' } } }])), /Forbidden|may not change/);
      l.pass('warm PVC attachment', 'API refuses changing running Pod volumes; claim volume templates force cold creation in 1.0.4', 'PARTIAL');
    }
    await l.k('delete', 'sandboxclaim', `claim-${i}`, '--wait=true');
    await until(async () => !(await l.k('get', 'pod', name, '--ignore-not-found')), 'bound Pod destroyed');
    console.log(`claim ${i + 1}: ${claims.at(-1)} ms`);
  }
  const neutral = await until(async () => JSON.parse(await l.k('get', 'pods', '-l', 'app=computer', '-o', 'json')).items.find(p => p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')), 'pool replenished');
  await l.apply({ apiVersion: l.api, kind: 'SandboxClaim', metadata: { name: 'with-volume' }, spec: {
    warmPoolRef: { name: 'pool' }, volumeClaimTemplates: [{ metadata: { name: 'extra' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }],
  } });
  const coldName = await until(async () => { const c = JSON.parse(await l.k('get', 'sandboxclaim/with-volume', '-o', 'json')); return c.status?.conditions?.some(x => x.type === 'Ready' && x.status === 'True') && c.status.sandbox.name; }, 'claim with volume');
  assert.notEqual(JSON.parse(await l.k('get', 'pod', coldName, '-o', 'json')).metadata.uid, neutral.metadata.uid);
  assert.equal(JSON.parse(await l.k('get', 'pod', neutral.metadata.name, '-o', 'json')).metadata.uid, neutral.metadata.uid);
  l.pass('volume claim cold start', 'claim with volumeClaimTemplates creates another Pod while ready neutral Pod remains unclaimed');
  await l.k('delete', 'sandboxclaim/with-volume', '--wait=true');
  await l.k('delete', 'sandboxwarmpool', 'pool', '--wait=true');
  const first = await l.computer('disk-0');
  const pvc = JSON.parse(await l.k('get', 'pvc/disk', '-o', 'json'));
  const runtimePods = JSON.parse(await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'pods', '-o', 'json']));
  const runtime = await command('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'inspectp', runtimePods.items.find(p => p.metadata.uid === first.metadata.uid).id]);
  assert.match(runtime, /io.containerd.runsc.v1/); l.pass('runtime', 'CRI confirms io.containerd.runsc.v1');
  d = await driver(l, 'disk-0');
  const thread = (await d.rpc('thread/start', { cwd: '/workspace' })).thread.id;
  await d.turn(thread, 'ISOLATION: execute the isolation probe then reply.');
  assert.match(JSON.stringify(await l.records()), /ISOLATION_PASS/);
  l.pass('S0.1b isolation', 'real model-requested tool returns ISOLATION_PASS in extended image');
  await l.exec('disk-0', `import {writeFileSync} from 'node:fs';process.setgroups([]);process.setgid(1001);process.setuid(1001);writeFileSync('/workspace/proof','persistent work');`);
  const browser = async (pod, mode) => {
    const capability = await l.exec('backend', `console.log(await fetch('http://127.0.0.1:9006').then(r=>r.text()))`);
    return input('kubectl', ['-n', l.ns, 'exec', '-i', pod, '--', 'setpriv', '--no-new-privs', 'node', '/lifecycle/browser.mjs', `http://${l.backend}:3000/site`, mode], capability);
  };
  assert.equal(await l.exec('disk-0', `console.log((await fetch('http://${l.backend}:3000/site/account')).status)`), '403');
  assert.match(await browser('disk-0', 'login'), /BROWSER_PASS/);
  const resumed = [], milestones = [], suspended = []; let previous = first;
  const sandboxUid = JSON.parse(await l.k('get', 'sandbox/disk-0', '-o', 'json')).metadata.uid;
  for (let i = 1; i <= 10; i++) {
    const oldGrant = await l.admin('issue', { thread, ttl: 120000 });
    d.child.kill();
    const suspendStart = performance.now();
    await l.k('patch', 'sandbox/disk-0', '--type=merge', '-p', JSON.stringify({ spec: { operatingMode: 'Suspended' } }));
    await until(async () => !(await l.k('get', 'pod/disk-0', '--ignore-not-found')), 'suspend frees Pod');
    await l.k('wait', '--for=condition=Suspended', 'sandbox/disk-0', '--timeout=120s');
    suspended.push(Math.round(performance.now() - suspendStart));
    assert.equal(JSON.parse(await l.k('get', 'sandbox/disk-0', '-o', 'json')).metadata.uid, sandboxUid);
    assert.equal(JSON.parse(await l.k('get', 'pvc/disk', '-o', 'json')).metadata.uid, pvc.metadata.uid);
    await l.admin('rotate');
    const start = performance.now(), times = {};
    const mark = name => { times[name] = Math.round(performance.now() - start); };
    await l.k('patch', 'sandbox/disk-0', '--type=merge', '-p', JSON.stringify({ spec: { operatingMode: 'Running' } }));
    await until(async () => (await l.k('get', 'pod/disk-0', '--ignore-not-found')).length, 'resumed Pod exists');
    await l.k('wait', '--for=condition=Ready', 'pod/disk-0', '--timeout=120s');
    mark('podReady');
    const pod = JSON.parse(await l.k('get', 'pod/disk-0', '-o', 'json'));
    assert.notEqual(pod.metadata.uid, previous.metadata.uid); previous = pod;
    assert.equal(JSON.parse(await l.k('get', 'sandbox/disk-0', '-o', 'json')).metadata.uid, sandboxUid);
    d = await driver(l, 'disk-0');
    mark('codexReady');
    const result = await d.rpc('thread/resume', { threadId: thread });
    assert.equal(result.thread.id, thread); assert.ok(result.thread.turns.length > 0);
    mark('threadReady');
    const fresh = await l.admin('issue', { thread, ttl: 120000 });
    assert.notEqual(oldGrant.computer, fresh.computer); assert.notEqual(oldGrant.token, fresh.token);
    const check = value => l.exec('backend', `import {body,call} from '/spike/common.mjs';const g=JSON.parse(await body(process.stdin));console.log((await call('http://127.0.0.1:3000/v1/responses',{input:[]},{authorization:'Bearer '+g.computer,'x-turn-token':g.token,'session-id':g.thread})).status)`, value);
    assert.equal(await check({ ...fresh, computer: oldGrant.computer }), '403');
    assert.equal(await check({ ...fresh, token: oldGrant.token }), '403');
    await d.turn(thread, `Continue after disk resume ${i}.`);
    assert.equal(await l.exec('disk-0', `import {readFileSync} from 'node:fs';console.log(readFileSync('/workspace/proof','utf8'));`), 'persistent work');
    mark('checksReady'); // Revoked grants, completed turn and workspace read.
    assert.match(await browser('disk-0', 'account'), /BROWSER_PASS/);
    mark('browserReady');
    milestones.push(times);
    resumed.push(Math.round(performance.now() - start));
    console.log(`resume ${i}: ${JSON.stringify(times)} ms`);
  }
  const stats = values => { const sorted = [...values].sort((a, b) => a - b); return { runs: values, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
  const latency = { unit: 'ms', claim: stats(claims), suspend: stats(suspended), coldPvcResume: stats(resumed), milestones,
    cumulative: Object.fromEntries(Object.keys(milestones[0]).map(key => [key, stats(milestones.map(m => m[key]))])),
    stages: Object.fromEntries(Object.keys(milestones[0]).map((key, i, keys) => [key, stats(milestones.map(m => m[key] - (i ? m[keys[i - 1]] : 0)))])) };
  writeFileSync(`${l.state}/latency.json`, JSON.stringify(latency, null, 2) + '\n');
  l.pass('warm claims', '10 pre-existing Pod UIDs adopted, computer label assigned at claim, all destroyed after binding');
  l.pass('disk suspend/resume', '10 Suspended/Running transitions retain Sandbox and PVC UIDs, free the Pod and create new gVisor Pods; file, actual Chromium login and same Codex thread survive');
  l.pass('token refresh', '10 rotations; old computer + new turn and new computer + old turn each return 403; resumed Codex turns complete');
  l.pass('latency', JSON.stringify(latency));
} catch (e) { l.pass('run', e.message, 'FAIL'); throw e; }
finally { d?.child.kill(); await l.clean(); }
