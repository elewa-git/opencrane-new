import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
const namespace = process.env.KUBE_NAMESPACE;
if (!namespace || !/^[a-z0-9-]+$/u.test(namespace)) {
  throw new Error('Worker namespace is missing');
}
const certificate = await readFile(`${serviceAccount}/ca.crt`);
const token = (await readFile(`${serviceAccount}/token`, 'utf8')).trim();
const kubeconfig = {
  apiVersion: 'v1', kind: 'Config',
  clusters: [{ name: 'local', cluster: {
    server: 'https://kubernetes.default.svc:443',
    'certificate-authority-data': certificate.toString('base64'),
  } }],
  users: [{ name: 'worker', user: { token } }],
  contexts: [{ name: 'local', context: { cluster: 'local', user: 'worker', namespace } }],
  'current-context': 'local',
};
const path = '/tmp/package-kubeconfig';
await writeFile(path, JSON.stringify(kubeconfig), { mode: 0o600 });
const mode = process.argv[2];
if (!mode) throw new Error('Worker mode is missing');
const child = spawn(process.execPath, ['--experimental-strip-types',
  'apps/ops/src/worker.ts', mode], {
  env: { ...process.env, KUBECONFIG: path }, stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
