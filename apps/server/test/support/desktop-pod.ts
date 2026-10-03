import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { z } from 'zod';
import { expect } from 'vitest';

const run = promisify(execFile);
export async function desktopPod() {
  const namespace = `p316-view-${randomUUID().slice(0, 8)}`, kubeconfig = process.env['KUBECONFIG'] ?? `${homedir()}/.kube/config`;
  const directory = await mkdtemp(`${tmpdir()}/p316-`);
  const k = async (...args: string[]) => (await run('kubectl', ['--kubeconfig', kubeconfig, '--context=k3d-ocn', '-n', namespace, ...args], { timeout: 120_000, maxBuffer: 2_000_000 })).stdout.trim();
  expect((await run('kubectl', ['--kubeconfig', kubeconfig, 'config', 'current-context'])).stdout.trim()).toBe('k3d-ocn');
  await k('create', 'namespace', namespace);
  const close = async () => { await k('delete', 'namespace', namespace, '--wait=true', '--timeout=120s'); await rm(directory, { recursive: true, force: true }); };
  try {
    const template = z.object({ spec: z.object({ podTemplate: z.object({ spec: z.record(z.string(), z.unknown()) }) }) }).parse(JSON.parse(await readFile('apps/computer/sandbox-template.json', 'utf8')) as unknown);
    const spec = template.spec.podTemplate.spec;
    const container = z.record(z.string(), z.unknown()).parse(z.array(z.unknown()).parse(spec['containers'])[0]);
    container['command'] = ['/bin/sh', '-c', 'chown 1002:1002 /home/desktop; exec setpriv --no-new-privs node --experimental-strip-types /app/src/desktop.ts'];
    container['env'] = [{ name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }]; container['readinessProbe'] = { tcpSocket: { port: 6901 }, periodSeconds: 1 };
    spec['containers'] = [container];
    await writeFile(`${directory}/pod.json`, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'desktop', labels: { app: 'computer' } }, spec }));
    await k('apply', '-f', `${directory}/pod.json`); await k('apply', '-f', 'apps/computer/network-policy.json');
    await k('wait', '--for=condition=Ready', 'pod/desktop', '--timeout=120s');
    const pod = z.object({ metadata: z.object({ uid: z.string() }), spec: z.object({ runtimeClassName: z.string() }), status: z.object({ podIP: z.string() }) }).parse(JSON.parse(await k('get', 'pod/desktop', '-o', 'json')) as unknown);
    expect(pod.spec.runtimeClassName).toBe('gvisor');
    const runtimes = (await run('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'pods', '-o', 'json'])).stdout;
    const runtime = z.object({ items: z.array(z.object({ id: z.string(), metadata: z.object({ uid: z.string() }) })) }).parse(JSON.parse(runtimes) as unknown).items.find(p => p.metadata.uid === pod.metadata.uid)!;
    expect((await run('docker', ['exec', 'k3d-ocn-server-0', 'crictl', 'inspectp', runtime.id])).stdout).toContain('io.containerd.runsc.v1');
    return { namespace, kubeconfig, uid: pod.metadata.uid, ip: pod.status.podIP, image: container['image'], k, close };
  } catch (error) { await close(); throw error; }
}
