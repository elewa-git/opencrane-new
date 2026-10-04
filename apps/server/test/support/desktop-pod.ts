import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { z } from 'zod';
import { expect } from 'vitest';

const run = promisify(execFile);
export async function desktopPod(withComputer = false) {
  const namespace = `computer-view-${randomUUID().slice(0, 8)}`, adminConfig = process.env['KUBECONFIG'] ?? `${homedir()}/.kube/config`;
  const directory = await mkdtemp(`${tmpdir()}/p316-`);
  const k = async (...args: string[]) => (await run('kubectl', ['--kubeconfig', adminConfig, '--context=k3d-ocn', '-n', namespace, ...args], { timeout: 120_000, maxBuffer: 2_000_000 })).stdout.trim();
  expect((await run('kubectl', ['--kubeconfig', adminConfig, 'config', 'current-context'])).stdout.trim()).toBe('k3d-ocn');
  await k('create', 'namespace', namespace);
  const close = async () => {
    try { await k('delete', 'namespace', namespace, '--wait=true', '--timeout=120s'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    await k('apply', '-f', 'infra/dev-stack/computer-worker-rbac.yaml');
    const current = z.object({ clusters: z.array(z.object({ cluster: z.record(z.string(), z.unknown()) })) }).parse(
      JSON.parse((await run('kubectl', ['--kubeconfig', adminConfig, 'config', 'view', '--raw', '--minify', '-o', 'json'])).stdout) as unknown);
    const token = await k('create', 'token', 'computer-lifecycle', '--duration=10m');
    const kubeconfig = `${directory}/worker.json`;
    await writeFile(kubeconfig, JSON.stringify({ apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'test', cluster: current.clusters[0]!.cluster }], users: [{ name: 'worker', user: { token } }],
      contexts: [{ name: 'test', context: { cluster: 'test', user: 'worker', namespace } }], 'current-context': 'test' }), { mode: 0o600 });
    const restricted = async (...args: string[]) => (await run('kubectl', ['--kubeconfig', kubeconfig, '-n', namespace, ...args], { timeout: 10_000, maxBuffer: 2_000_000 })).stdout.trim();
    const template = z.object({ spec: z.object({ podTemplate: z.object({ spec: z.record(z.string(), z.unknown()) }) }) }).parse(JSON.parse(await readFile('apps/computer/sandbox-template.json', 'utf8')) as unknown);
    const spec = template.spec.podTemplate.spec;
    const container = z.record(z.string(), z.unknown()).parse(z.array(z.unknown()).parse(spec['containers'])[0]);
    if (process.env['COMPUTER_TEST_IMAGE']) { container['image'] = process.env['COMPUTER_TEST_IMAGE']; container['imagePullPolicy'] = 'Never'; }
    if (withComputer) {
      const services = await readFile('spikes/s0-1b-proxy-gvisor/services.mjs', 'utf8');
      const provider = services.slice(services.indexOf('let index = 0;')).replace('/spike/probe.mjs', '/workspace/probe.mjs').replace("!text.includes('AFTER_RELEASE')", "!text.includes('explicitly returned computer control')").replace("}).listen(9003, '0.0.0.0');", "}).listen(3000, '0.0.0.0');");
      const stub = `import {createServer} from 'node:http'; import {appendFileSync,readFileSync} from 'node:fs'; import {body,json,sleep} from './common.mjs';
const log = (file, entry) => appendFileSync('/tmp/'+file+'.jsonl', JSON.stringify({thread:entry.thread})+'\\n');\n${provider}`;
      await writeFile(`${directory}/stub.mjs`, stub);
      await k('create', 'configmap', 'provider', `--from-file=${directory}/stub.mjs`, '--from-file=spikes/s0-1b-proxy-gvisor/common.mjs');
      await writeFile(`${directory}/provider.json`, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'provider', labels: { app: 'opencrane-gateway' } }, spec: { automountServiceAccountToken: false, containers: [{ name: 'provider', image: container['image'], command: ['node', '/fixtures/stub.mjs'], volumeMounts: [{ name: 'fixtures', mountPath: '/fixtures' }] }], volumes: [{ name: 'fixtures', configMap: { name: 'provider' } }] } }));
      await k('apply', '-f', `${directory}/provider.json`); await k('wait', '--for=condition=Ready', 'pod/provider', '--timeout=120s');
      const ip = await k('get', 'pod/provider', '-o', 'jsonpath={.status.podIP}');
      container['env'] = [{ name: 'GATEWAY', value: `http://${ip}:3000` }, { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }];
    } else container['command'] = ['/bin/sh', '-c', 'chown 1002:1002 /home/desktop; exec setpriv --no-new-privs node --experimental-strip-types /app/src/desktop.ts'];
    if (!withComputer) container['env'] = [{ name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }]; if (!withComputer) container['readinessProbe'] = { tcpSocket: { port: 6901 }, periodSeconds: 1 };
    spec['containers'] = [container];
    await writeFile(`${directory}/pod.json`, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'desktop', labels: { app: 'computer' } }, spec }));
    await k('apply', '-f', `${directory}/pod.json`); await k('apply', '-f', 'apps/computer/network-policy.json');
    await k('wait', '--for=condition=Ready', 'pod/desktop', '--timeout=120s');
    const pod = z.object({ metadata: z.object({ uid: z.string() }), spec: z.object({ runtimeClassName: z.string() }), status: z.object({ podIP: z.string() }) }).parse(JSON.parse(await k('get', 'pod/desktop', '-o', 'json')) as unknown);
    expect(pod.spec.runtimeClassName).toBe('gvisor');
    const runtimes = (await run('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'pods', '-o', 'json'])).stdout;
    const runtime = z.object({ items: z.array(z.object({ id: z.string(), metadata: z.object({ uid: z.string() }) })) }).parse(JSON.parse(runtimes) as unknown).items.find(p => p.metadata.uid === pod.metadata.uid)!;
    expect((await run('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'inspectp', runtime.id])).stdout).toContain('io.containerd.runsc.v1');
    return { namespace, kubeconfig, uid: pod.metadata.uid, ip: pod.status.podIP, image: container['image'], k, restricted, close };
  } catch (error) { await close(); throw error; }
}
