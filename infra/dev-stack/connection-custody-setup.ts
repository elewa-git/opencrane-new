import { z } from 'zod';
import { mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export interface ConnectionCustodySetup {
  namespace: string;
  directory: string;
  port: string;
  run: (command: string, args: string[]) => Promise<string>;
  save: (name: string, value: string) => Promise<void>;
}

export type ConnectionCustodyFileSetup = Pick<ConnectionCustodySetup,
  'directory' | 'namespace' | 'port' | 'save'>;

export async function prepareConnectionCustodyFile(setup: ConnectionCustodyFileSetup) {
  await mkdir(`${setup.directory}/models`, { recursive: true, mode: 0o700 });
  const configuration = 'models/connection-custody.json';
  try {
    await stat(`${setup.directory}/${configuration}`);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('base64');
    const config = { apiUrl: `http://127.0.0.1:${setup.port}`, namespace: setup.namespace,
      journalDirectory: `${setup.directory}/models/connection-journal`,
      currentKeyId: 'dev', keys: { dev: key } };
    await setup.save(configuration, JSON.stringify(config));
  }
  return `${setup.directory}/${configuration}`;
}

/** Give the existing secret-store adapter its own namespace and short-lived Kubernetes identity. */
export async function prepareConnectionCustody(setup: ConnectionCustodySetup) {
  await setup.run('kubectl', ['create', 'namespace', setup.namespace,
    '--dry-run=client', '-o', 'yaml']).then(saveNamespace);
  async function saveNamespace(manifest: string) {
    await setup.save('connection-namespace.yaml', manifest);
  }
  await setup.run('kubectl', ['apply', '-f', `${setup.directory}/connection-namespace.yaml`]);
  await setup.run('kubectl', ['-n', setup.namespace, 'apply', '-f',
    'infra/dev-stack/connection-custody-rbac.yaml']);
  const rawSchema = z.object({ clusters: z.array(z.object({ cluster: z.unknown() })).min(1) });
  const rawJson = await setup.run('kubectl',
    ['config', 'view', '--raw', '--minify', '-o', 'json']);
  const raw = rawSchema.parse(JSON.parse(rawJson));
  const token = (await setup.run('kubectl', ['-n', setup.namespace, 'create', 'token',
    'connection-custody', '--duration=24h'])).trim();
  const config = { apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'custody', cluster: raw.clusters[0]?.cluster }],
    users: [{ name: 'custody', user: { token } }],
    contexts: [{ name: 'custody', context: { cluster: 'custody', user: 'custody',
      namespace: setup.namespace } }], 'current-context': 'custody' };
  await setup.save('connection-custody-kubeconfig.json', JSON.stringify(config));
  const file = await prepareConnectionCustodyFile(setup);
  return { CONNECTION_CUSTODY_FILE: file,
    CONNECTION_CUSTODY_SOCKET: `${setup.directory}/models/connection-proxy.sock`,
    CONNECTION_CUSTODY_KUBECONFIG: `${setup.directory}/connection-custody-kubeconfig.json`,
    CONNECTION_CUSTODY_NAMESPACE: setup.namespace, CUSTODY_PROXY_PORT: setup.port };
}
