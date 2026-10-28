import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { until } from '@opencrane/authz/testing';

const run = promisify(execFile);
/** A private namespace/PVC runs the real bridge with a durable counting Codex boundary. */
export async function bridgePod() {
  const namespace = `bridge-fence-${randomUUID().slice(0, 8)}`, directory = await mkdtemp(`${tmpdir()}/bridge-pod-`);
  const kubectl = async (...args: string[]) => (await run('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args], { timeout: 120_000 })).stdout;
  let forwarding: ReturnType<typeof spawn> | undefined;
  const close = async () => {
    if (forwarding && forwarding.exitCode === null && forwarding.signalCode === null) { const exited = once(forwarding, 'exit'); forwarding.kill(); await exited; forwarding = undefined; }
    await kubectl('delete', 'namespace', namespace, '--wait=false'); await rm(directory, { recursive: true, force: true });
  };
  await kubectl('create', 'namespace', namespace);
  try {
    const image = `127.0.0.1:5001/opencrane/bridge-fence:${namespace}`;
    const dockerfile = `${directory}/Dockerfile`;
    await writeFile(dockerfile, `FROM mirror.gcr.io/library/node:22.23.1-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27
WORKDIR /app
COPY node_modules/ws /app/node_modules/ws
COPY libs/models/package.json /app/libs/models/package.json
COPY libs/models/src/routing.ts /app/libs/models/src/routing.ts
RUN mkdir -p /app/node_modules/@opencrane && ln -s ../../libs/models /app/node_modules/@opencrane/models
COPY apps/computer/src/channel.ts apps/computer/src/files.ts apps/computer/src/http.ts /app/src/
CMD ["node", "--experimental-strip-types", "/driver/driver.mjs"]
`);
    await run('docker', ['build', '-f', dockerfile, '-t', image, '.'], { timeout: 120_000 });
    await run('docker', ['push', image], { timeout: 120_000 });
    await writeFile(`${directory}/driver.mjs`, `import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { bridgeChannel } from '/app/src/channel.ts';
const server = createServer((req, res) => {
  if (req.url === '/complete') channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
  res.end(String(existsSync('/disk/runs') ? readFileSync('/disk/runs', 'utf8').trim().split('\\n').length : 0));
});
const channel = bridgeChannel(server, {
  journal: '/disk/reports', credential: () => ({ value: 'computer', expiresAt: Date.now()+600000 }),
  grant: async () => {}, rpc: async method => { if (method === 'turn/start') appendFileSync('/disk/runs', 'run\\n', { flush: true }); return { thread: { id: 'thread' } }; },
});
server.listen(8081, '0.0.0.0');
`);
    await kubectl('create', 'configmap', 'driver', `--from-file=${directory}/driver.mjs`);
    await writeFile(`${directory}/pvc.json`, JSON.stringify({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'disk' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }));
    await kubectl('apply', '-f', `${directory}/pvc.json`);
    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'bridge' }, spec: { automountServiceAccountToken: false, runtimeClassName: 'gvisor', containers: [{ name: 'bridge', image: image.replace('127.0.0.1:5001', 'k3d-ocn-registry:5000'), ports: [{ containerPort: 8081 }], volumeMounts: [{ name: 'disk', mountPath: '/disk' }, { name: 'driver', mountPath: '/driver' }] }], volumes: [{ name: 'disk', persistentVolumeClaim: { claimName: 'disk' } }, { name: 'driver', configMap: { name: 'driver' } }] } };
    await writeFile(`${directory}/pod.json`, JSON.stringify(pod));
    async function start() {
      await kubectl('apply', '-f', `${directory}/pod.json`);
      await kubectl('wait', '--for=condition=Ready', 'pod/bridge', '--timeout=120s');
      forwarding = spawn('kubectl', ['--context=k3d-ocn', 'proxy', '--port=0', '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; forwarding.stdout?.on('data', (value: Buffer) => { output += value.toString(); });
      await until(() => { if (forwarding?.exitCode !== null) throw new Error('Kubernetes proxy exited'); return /127.0.0.1:(\d+)/u.test(output); });
      const port = /127.0.0.1:(\d+)/u.exec(output)![1];
      const url = `http://127.0.0.1:${port}/api/v1/namespaces/${namespace}/pods/bridge:8081/proxy`;
      await until(async () => { try { return (await fetch(url)).ok; } catch { return false; } });
      return url;
    }
    let url = await start();
    return { get url() { return url; }, runs: async () => Number(await (await fetch(url)).text()),
      complete: async () => { await fetch(`${url}/complete`); },
      async replace() {
        const exited = once(forwarding!, 'exit'); forwarding!.kill(); await exited; forwarding = undefined;
        await kubectl('delete', 'pod', 'bridge', '--wait=true'); url = await start();
      }, close };
  } catch (error) { await close(); throw error; }
}
