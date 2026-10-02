// Real local-path PVC, native suspension and new gVisor Pods, including old unsafe layouts.
import assert from 'node:assert/strict';
import { until } from '../../../spikes/s0-3-warm-pool/lab.mjs';
export async function resume({ k, apply, exec, template, pass }) {
  const spec = structuredClone(template.spec.podTemplate.spec);
  spec.volumes[0] = { name: 'home', persistentVolumeClaim: { claimName: 'disk' } };
  await apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'disk' }, spec: {
    accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } },
  } });
  await apply({ apiVersion: 'agents.x-k8s.io/v1beta1', kind: 'Sandbox', metadata: { name: 'resume' }, spec: {
    podTemplate: { metadata: { labels: { app: 'computer' } }, spec },
  } });
  await until(async () => (await k('get', 'pod/resume', '--ignore-not-found')).length, 'PVC Pod');
  await k('wait', '--for=condition=Ready', 'pod/resume', '--timeout=180s');
  const first = JSON.parse(await k('get', 'pod/resume', '-o', 'json'));
  const pvc = JSON.parse(await k('get', 'pvc/disk', '-o', 'json')).metadata.uid;
  await exec('resume', "import {writeFileSync} from 'node:fs';process.setgroups([]);process.setgid(1001);process.setuid(1001);writeFileSync('/workspace/retained','PVC canary');");
  await k('patch', 'sandbox/resume', '--type=merge', '-p', JSON.stringify({ spec: { operatingMode: 'Suspended' } }));
  await k('wait', '--for=delete', 'pod/resume', '--timeout=120s');
  const seedSpec = structuredClone(spec);
  seedSpec.restartPolicy = 'Never';
  delete seedSpec.containers[0].readinessProbe;
  seedSpec.containers[0].command = ['node', '-e', 'setInterval(()=>{},1000)'];
  await apply({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'seed' }, spec: seedSpec });
  await k('wait', '--for=condition=Ready', 'pod/seed', '--timeout=120s');
  // Run the real entrypoint against each hostile disk and inspect the untouched target in the same container.
  for (const kind of ['symlink', 'fifo', 'dangling']) {
    await exec('seed', `
      import assert from 'node:assert/strict';
      import {renameSync,rmSync,chmodSync,statSync,readFileSync} from 'node:fs';
      import {spawnSync} from 'node:child_process';
      import {createHash} from 'node:crypto';
      const signature=()=>JSON.stringify([statSync('/usr/local/bin').uid,statSync('/usr/local/bin').mode,
        createHash('sha256').update(readFileSync('/usr/local/bin/tool-user')).digest('hex')]);
      const before=signature();
      renameSync('/home/agent/workspace','/home/agent/saved');chmodSync('/home/agent',0o777);
      const attack=${JSON.stringify(kind === 'fifo' ? "require('child_process').execFileSync('/usr/bin/mkfifo',['/home/agent/workspace'])" : `require('fs').symlinkSync('${kind === 'symlink' ? '/usr/local/bin' : '/missing-target'}','/home/agent/workspace')`)};
      assert.equal(spawnSync('/usr/local/bin/node',['-e',attack],{uid:1001,gid:1001}).status,0);
      const result=spawnSync('/usr/local/bin/node',['--experimental-strip-types','/app/src/entrypoint.ts'],{encoding:'utf8',timeout:15000});
      assert.notEqual(result.status,0);assert.match(result.stderr,/Unsafe directory: workspace/);
      assert.equal(signature(),before);assert.ok(!result.stdout.includes('"report":"ready"'));
      assert.equal(statSync('/home/agent').uid,0);assert.equal(statSync('/home/agent').mode&0o777,0o755);
      rmSync('/home/agent/workspace');renameSync('/home/agent/saved','/home/agent/workspace');
    `);
    pass(`hostile PVC ${kind}`, 'UID 1001 creates attack in legacy 0777 PVC; real entrypoint refuses before services; launcher hash and target ownership/mode unchanged');
  }
  await exec('seed', "import {chmodSync} from 'node:fs';chmodSync('/home/agent',0o777)");
  await k('delete', 'pod/seed', '--wait=true');
  await k('patch', 'sandbox/resume', '--type=merge', '-p', JSON.stringify({ spec: { operatingMode: 'Running' } }));
  await until(async () => (await k('get', 'pod/resume', '--ignore-not-found')).length, 'resumed PVC Pod');
  await k('wait', '--for=condition=Ready', 'pod/resume', '--timeout=180s');
  const resumed = JSON.parse(await k('get', 'pod/resume', '-o', 'json'));
  assert.notEqual(resumed.metadata.uid, first.metadata.uid);
  assert.equal(JSON.parse(await k('get', 'pvc/disk', '-o', 'json')).metadata.uid, pvc);
  assert.equal(await exec('resume', "console.log((await import('node:fs')).readFileSync('/workspace/retained','utf8'))"), 'PVC canary');
  pass('PVC resume', 'same PVC, new Pod after native suspension; retained file and safely repaired 0777 volume root');
  return 'resume';
}
