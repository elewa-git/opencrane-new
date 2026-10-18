import { readFile, writeFile } from 'node:fs/promises';

const account = '/var/run/secrets/kubernetes.io/serviceaccount';
const token = (await readFile(`${account}/token`, 'utf8')).trim();
const certificate = (await readFile(`${account}/ca.crt`)).toString('base64');
const namespace = (await readFile(`${account}/namespace`, 'utf8')).trim();
const host = process.env['KUBERNETES_SERVICE_HOST'];
const port = process.env['KUBERNETES_SERVICE_PORT'];
if (!host || !port) throw new Error('Kubernetes service is missing');

const config = {
  apiVersion: 'v1', kind: 'Config',
  clusters: [{ name: 'local', cluster: {
    server: `https://${host}:${port}`, 'certificate-authority-data': certificate,
  } }],
  users: [{ name: 'package', user: { token } }],
  contexts: [{ name: 'local', context: { cluster: 'local', user: 'package', namespace } }],
  'current-context': 'local',
};
await writeFile('/run/kubeconfig/config.json', JSON.stringify(config), { mode: 0o600 });
