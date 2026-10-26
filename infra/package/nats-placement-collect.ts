import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { directory } from '../dev-stack/config.ts';
import { requireAutomatedJourney } from '../dev-stack/journey-guard.ts';
import { verifyPackageOwner } from '../dev-stack/packaged.ts';
import { checkNatsPlacement } from './nats-placement.ts';
import { targetConnection, targetRecorded } from '../dev-stack/target.ts';

const execute = promisify(execFile);

async function readBoundedJson(path: string) {
  const file = await open(path, 'r');
  try {
    const details = await file.stat();
    if (!details.isFile() || details.size > 1024 * 1024) throw new Error('Input refused');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

async function collect(freshFile: string, streamFile: string, destination: string) {
  requireAutomatedJourney();
  // Refuse the shared cluster before package verification can query it.
  if (!await targetRecorded()) throw new Error('A recorded three-node target is required');
  const connection = await targetConnection();
  const owner = await verifyPackageOwner();
  if (!connection.kubeconfig || owner.context !== connection.context) {
    throw new Error('Target connection refused');
  }
  const options = ['--kubeconfig', connection.kubeconfig, '--context', connection.context,
    '--request-timeout=8s'];
  async function kubernetes(args: string[]) {
    const result = await execute('kubectl', [...options, ...args],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout) as unknown;
  }
  const scope = ['-n', owner.namespace];
  const namespace = await kubernetes(['get', 'namespace', owner.namespace, '-o', 'json']);
  // Read only release metadata; Helm's data contains private package settings.
  const releaseMetadata = await kubernetes([...scope, 'get', 'secret',
    `sh.helm.release.v1.${owner.release}.v1`, '-o', 'jsonpath={.metadata}']);
  const nodes = await kubernetes(['get', 'nodes', '-o', 'json']);
  const pods = await kubernetes([...scope, 'get', 'pods', '-o', 'json']);
  const claims = await kubernetes([...scope, 'get', 'pvc', '-o', 'json']);
  const resources = await execute('kubectl', [...options, 'api-resources',
    '--api-group=gateway.networking.k8s.io', '--no-headers', '--output=name'],
  { timeout: 10_000, maxBuffer: 1024 * 1024 });
  let endpointKinds = 'services,ingresses';
  if (resources.stdout.split('\n').includes('gateways.gateway.networking.k8s.io')) {
    endpointKinds += ',gateways.gateway.networking.k8s.io';
  }
  const endpoints = await kubernetes([...scope, 'get', endpointKinds, '-o', 'json']);
  const fresh = await readBoundedJson(freshFile);
  const stream = await readBoundedJson(streamFile);
  const target = JSON.parse(await readFile(`${directory}/target-owner.json`, 'utf8')) as {
    id: string; nodes: Record<string, string>;
  };
  const review = JSON.parse(await readFile('infra/package/reviewed-images.json', 'utf8')) as {
    images: { nats: string };
  };
  const current = await verifyPackageOwner();
  await targetConnection();
  if (current.namespaceUid !== owner.namespaceUid || current.installId !== owner.installId ||
      current.releaseSecretUid !== owner.releaseSecretUid) throw new Error('Owner changed');
  if (!owner.installId || !owner.releaseSecretUid) throw new Error('Release not recorded');
  const evidence = { namespace, release: { metadata: releaseMetadata }, nodes, pods, claims,
    endpoints, fresh, stream, target, owner, collectedAt: new Date().toISOString() };
  const expected = { ...owner, targetId: target.id, nodeUids: target.nodes,
    startedAt: (fresh as { startedAt: string }).startedAt, image: review.images.nats,
    installId: owner.installId, releaseSecretUid: owner.releaseSecretUid };
  const summary = checkNatsPlacement(evidence, expected);
  const file = await open(destination, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(summary) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}

function timedOut() {
  process.stderr.write('NATS placement collection refused\n');
  process.exit(1);
}
const deadline = setTimeout(timedOut, 60_000);
try {
  const [fresh, stream, destination, extra] = process.argv.slice(2);
  if (!fresh || !stream || !destination || extra) throw new Error('Arguments refused');
  await collect(fresh, stream, destination);
  process.stdout.write('Checked Kubernetes placement only; full qualification remains outstanding\n');
} catch {
  // Withhold paths, credentials and dependency output, including on malformed input.
  process.stderr.write('NATS placement collection refused\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
