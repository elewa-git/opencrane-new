import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostFailures, type HostState } from '../package/host-preflight.mjs';

export type HostCheckOptions = {
  command: (args: string[]) => Promise<string>;
  namespace: string;
  image: string;
  override?: string;
  localCommand?: (program: string, args: string[]) => Promise<string>;
};
export type HostCheckRecord = {
  checkedAt: string;
  nodes: Array<{ name: string; uid: string; failures: string[] }>;
  override?: 'accepted-dev-box-366';
};
type NodeList = { items: Array<{ metadata: { name: string; uid: string } }> };

async function collectorSource() {
  const file = new URL('../package/host-preflight.mjs', import.meta.url);
  return readFile(file, 'utf8');
}

function probePod(node: string, options: HostCheckOptions, source: string) {
  const volumes = [];
  const volumeMounts = [];
  for (const directory of ['proc', 'etc', 'sys', 'dev']) {
    const volume = { name: directory, hostPath: { path: `/${directory}`, type: 'Directory' } };
    const mount = { name: directory, mountPath: `/host/${directory}`, readOnly: true };
    volumes.push(volume);
    volumeMounts.push(mount);
  }
  const script = source + '\nconsole.log(JSON.stringify(collectHost("/host")));';
  return {
    apiVersion: 'v1', kind: 'Pod',
    spec: {
      nodeName: node, restartPolicy: 'Never', activeDeadlineSeconds: 90,
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      containers: [{ name: 'probe', image: options.image,
        command: ['node', '--input-type=module', '-e', script], volumeMounts,
        resources: { requests: { cpu: '10m', memory: '32Mi' },
          limits: { cpu: '100m', memory: '128Mi' } },
        securityContext: { runAsUser: 0, readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      }], volumes,
    },
  };
}

async function probeNode(node: string, options: HostCheckOptions, source: string) {
  const name = `host-preflight-${randomUUID()}`;
  const prefix = ['-n', options.namespace];
  const pod = probePod(node, options, source);
  try {
    await options.command([...prefix, 'run', name, '--image', options.image,
      '--restart=Never', '--overrides', JSON.stringify(pod)]);
    await options.command([...prefix, 'wait', `pod/${name}`,
      '--for=jsonpath={.status.phase}=Succeeded', '--timeout=100s']);
    const output = await options.command([...prefix, 'logs', name]);
    return JSON.parse(output) as HostState;
  } finally {
    await options.command([...prefix, 'delete', 'pod', name, '--ignore-not-found', '--wait=true']);
  }
}

type LocalCommand = NonNullable<HostCheckOptions['localCommand']>;

async function requireLocalDocker(command: LocalCommand) {
  const host = process.env['DOCKER_HOST'];
  if (host && !host.startsWith('unix://')) {
    throw new Error('Cannot verify the underlying k3d host through a remote Docker endpoint');
  }
  const endpoint = await command('docker', ['context', 'inspect',
    '--format', '{{json .Endpoints.docker.Host}}']);
  if (!JSON.parse(endpoint).startsWith('unix://')) {
    throw new Error('Cannot verify the underlying k3d host through a remote Docker endpoint');
  }
}

async function requireLocalContainer(node: NodeList['items'][number], command: LocalCommand) {
  const name = node.metadata.name;
  if (!/^k3d-(ocn|opencrane-target-[12])-(server|agent)-\d+$/u.test(name)) {
    throw new Error('Host-risk override requires verified local k3d nodes');
  }
  const output = await command('docker', ['inspect', name]);
  const containers = JSON.parse(output) as Array<{
    Name: string; State: { Running: boolean }; Config: { Labels: Record<string, string> };
  }>;
  const container = containers[0];
  const cluster = name.replace(/^k3d-/u, '').replace(/-(server|agent)-\d+$/u, '');
  if (containers.length !== 1 || container?.Name !== `/${name}` ||
      !container.State.Running || container.Config.Labels['k3d.cluster'] !== cluster) {
    throw new Error('Cannot verify the underlying k3d host');
  }
  // Bind the API node to this local cluster; names and Docker labels alone can be copied.
  const server = `k3d-${cluster}-server-0`;
  const uid = await command('docker', ['exec', server, 'kubectl', 'get', 'node', name,
    '-o', 'jsonpath={.metadata.uid}']);
  if (uid !== node.metadata.uid) {
    throw new Error('Local k3d node identity differs from the installation target');
  }
}

async function localHost(nodes: NodeList, options: HostCheckOptions, source: string) {
  let local = false;
  for (const node of nodes.items) {
    if (node.metadata.name.startsWith('k3d-')) local = true;
  }
  if (!local) return undefined;
  if (!options.localCommand) throw new Error('Cannot verify the underlying k3d host');
  await requireLocalDocker(options.localCommand);
  // A k3d node shares the Docker host's memory and swap, outside its filesystem.
  for (const node of nodes.items) {
    await requireLocalContainer(node, options.localCommand);
  }
  const script = source + '\nconsole.log(JSON.stringify(collectHost()));';
  const output = await options.localCommand('node', ['--input-type=module', '-e', script]);
  return JSON.parse(output) as HostState;
}

function requireSameNodes(before: NodeList, after: NodeList) {
  if (before.items.length !== after.items.length) throw new Error('Installation nodes changed');
  for (const original of before.items) {
    let matched = false;
    for (const current of after.items) {
      if (original.metadata.name === current.metadata.name &&
          original.metadata.uid === current.metadata.uid) matched = true;
    }
    if (!matched) throw new Error('Installation nodes changed');
  }
}

function requireHostResults(record: HostCheckRecord, override: string | undefined) {
  const messages = [];
  for (const node of record.nodes) {
    for (const failure of node.failures) messages.push(`${node.name}: ${failure}`);
  }
  if (override === 'accepted-dev-box-366') {
    record.override = override;
    console.warn('HOST RISK OVERRIDE: accepted-dev-box-366; dev-box exception of 12 October 2026');
    for (const message of messages) console.warn(message);
  } else if (messages.length > 0) {
    throw new Error(messages.join('\n'));
  }
}

export async function checkPackageHosts(options: HostCheckOptions): Promise<HostCheckRecord> {
  if (options.override !== undefined && options.override !== 'accepted-dev-box-366') {
    throw new Error('Unknown host-risk override; omit OPENCRANE_ACCEPT_DEV_HOST_RISK');
  }
  const output = await options.command(['get', 'nodes', '-o', 'json']);
  const nodes = JSON.parse(output) as NodeList;
  if (!nodes.items.length) throw new Error('No installation nodes to check');
  const source = await collectorSource();
  const underlying = await localHost(nodes, options, source);
  if (options.override && !underlying) {
    throw new Error('Host-risk override requires verified local k3d nodes');
  }
  const record: HostCheckRecord = { checkedAt: new Date().toISOString(), nodes: [] };
  for (const node of nodes.items) {
    const state = await probeNode(node.metadata.name, options, source);
    const failures = hostFailures(state);
    const result = { name: node.metadata.name, uid: node.metadata.uid, failures };
    record.nodes.push(result);
  }
  if (underlying) {
    const result = { name: 'underlying-k3d-host', uid: 'local', failures: hostFailures(underlying) };
    record.nodes.push(result);
  }
  const current = await options.command(['get', 'nodes', '-o', 'json']);
  requireSameNodes(nodes, JSON.parse(current) as NodeList);
  requireHostResults(record, options.override);
  return record;
}
