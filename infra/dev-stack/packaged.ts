import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { directory, root } from './config.ts';
import { secondary, stackId } from './identity.ts';

const execute = promisify(execFile);
const context = 'k3d-ocn';
const namespace = `opencrane-package-${stackId}`;
const release = `opencrane-package-${stackId}`;
const recordFile = `${directory}/package-owner.json`;
const secretKeys: Record<string, string[]> = {
  runtime: ['NATS_URL', 'DATABASE_URL', 'SILO_ID', 'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_COOKIE_SECRET',
    'OIDC_CLIENT_SECRET_ENV_VAR',
    'OIDC_EXPECTED_ORG_ID', 'OPENFGA_API_URL', 'OPENFGA_STORE_ID', 'OPENFGA_MODEL_ID'],
  postgres: ['POSTGRES_PASSWORD'],
  nats: ['nats.conf', 'ca.crt', 'server.crt', 'server.key', 'NATS_LISTEN',
    'NATS_STORE_DIR', 'NATS_CA_FILE', 'NATS_CERT_FILE', 'NATS_KEY_FILE',
    'NATS_COMMAND_NKEY', 'NATS_PROJECTION_NKEY', 'NATS_DISPATCHER_NKEY',
    'NATS_COMPUTER_NKEY', 'NATS_GATEWAY_NKEY'],
  openfga: ['OPENFGA_DATASTORE_ENGINE', 'OPENFGA_DATASTORE_URI'],
};
const privateHosts: Record<string, string> = {
  NATS_URL: 'nats',
  DATABASE_URL: 'postgres',
  OPENFGA_API_URL: 'openfga',
  OPENFGA_DATASTORE_URI: 'postgres',
};

type Namespace = {
  metadata: { uid: string; annotations?: Record<string, string> };
};
type PackageOwner = {
  worktree: string;
  slot: string;
  context: string;
  namespace: string;
  namespaceUid: string;
  release: string;
  heartbeatAt: string;
  releaseSecretUid?: string;
};

async function command(program: string, args: string[], timeoutMs = 120_000) {
  const result = await execute(program, args, { cwd: root, timeout: timeoutMs });
  return result.stdout.trim();
}

async function kubectl(args: string[]) {
  return command('kubectl', [`--context=${context}`, ...args]);
}

async function readOwner() {
  try {
    return JSON.parse(await readFile(recordFile, 'utf8')) as PackageOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function getNamespace() {
  const output = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json']);
  if (!output) return undefined;
  return JSON.parse(output) as Namespace;
}

function ownedNamespace(found: Namespace, owner: PackageOwner) {
  return found.metadata.uid === owner.namespaceUid &&
    found.metadata.annotations?.['opencrane.dev/worktree'] === owner.worktree &&
    found.metadata.annotations?.['opencrane.dev/slot'] === owner.slot;
}

async function saveOwner(owner: PackageOwner) {
  owner.heartbeatAt = new Date().toISOString();
  await writeFile(recordFile, JSON.stringify(owner) + '\n', { mode: 0o600 });
}

export async function packagedSlotIsBusy() {
  if (!secondary) return false;
  try {
    const found = await getNamespace();
    if (!found) return false;
    const owner = await readOwner();
    if (owner?.worktree === root && ownedNamespace(found, owner)) await saveOwner(owner);
    return true;
  } catch {
    // Keep the slot claimed when Kubernetes cannot prove that its resources are gone.
    return true;
  }
}

async function requireOwner() {
  if (!secondary) throw new Error('A package needs a secondary slot');
  const record = await readFile(`${directory}/stack-owner`, 'utf8');
  if (!record.startsWith(`worktree=${root}\n`)) throw new Error('This worktree does not own the slot');
}

export async function preparePackage() {
  await requireOwner();
  if (await getNamespace()) throw new Error('Package namespace already exists');
  await kubectl(['create', 'namespace', namespace]);
  const found = await getNamespace();
  if (!found) throw new Error('Package namespace was not created');
  await kubectl(['annotate', 'namespace', namespace,
    `opencrane.dev/worktree=${root}`, `opencrane.dev/slot=${stackId}`]);
  const owner: PackageOwner = {
    worktree: root, slot: stackId, context, namespace,
    namespaceUid: found.metadata.uid, release, heartbeatAt: '',
  };
  await saveOwner(owner);
}

export async function verifyPackageOwner() {
  await requireOwner();
  const owner = await readOwner();
  const found = await getNamespace();
  if (!owner || owner.worktree !== root || owner.slot !== stackId ||
      owner.context !== context || owner.namespace !== namespace ||
      owner.release !== release || !found || !ownedNamespace(found, owner)) {
    throw new Error('Package ownership differs from the recorded namespace');
  }
  return owner;
}

export async function installPackage(valuesFile: string) {
  const reviewFile = 'infra/package/reviewed-images.json';
  await command('node', ['infra/package/preflight.mjs', valuesFile, reviewFile]);
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as {
    secrets: Record<string, string>;
  };
  const review = JSON.parse(await readFile(reviewFile, 'utf8')) as {
    requiredSecrets: string[];
    chartVersion: string;
    images: Record<string, string>;
  };
  const chart = await readFile('infra/package/chart/Chart.yaml', 'utf8');
  const version = chart.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/mu)?.[1];
  if (version !== review.chartVersion) throw new Error('Chart version is not reviewed');
  const owner = await verifyPackageOwner();
  for (const name of review.requiredSecrets) {
    const secret = values.secrets[name]!;
    const found = await kubectl(['-n', namespace, 'get', 'secret', secret,
      '--ignore-not-found', '-o', 'json']);
    if (!found) throw new Error(`Required secret is absent: ${name}`);
    const stored = JSON.parse(found) as { data?: Record<string, string> };
    for (const key of secretKeys[name] ?? []) {
      if (!stored.data?.[key]) throw new Error(`Required secret field is absent: ${name}.${key}`);
    }
    if (name === 'runtime') {
      const encodedName = stored.data!['OIDC_CLIENT_SECRET_ENV_VAR']!;
      const secretName = Buffer.from(encodedName, 'base64').toString('utf8').trim();
      if (!/^[A-Z][A-Z0-9_]*$/u.test(secretName) || !stored.data?.[secretName]) {
        throw new Error('OIDC client secret reference is absent');
      }
    }
    for (const [key, expectedHost] of Object.entries(privateHosts)) {
      if (!stored.data?.[key]) continue;
      const address = Buffer.from(stored.data[key], 'base64').toString('utf8');
      let actualHost: string;
      try {
        actualHost = new URL(address).hostname;
      } catch {
        throw new Error(`Invalid private service endpoint: ${key}`);
      }
      if (actualHost !== expectedHost) {
        throw new Error(`Service endpoint must stay private: ${key}`);
      }
    }
  }
  const rendered = await command('helm', ['template', release, 'infra/package/chart',
    '--namespace', namespace, '--values', valuesFile]);
  const reviewedImages = new Set(Object.values(review.images));
  const renderedImages = rendered.matchAll(/^\s*image:\s*"?([^"\n]+)"?\s*$/gmu);
  let imageCount = 0;
  for (const image of renderedImages) {
    imageCount++;
    if (!reviewedImages.has(image[1]!)) throw new Error('Rendered image is not reviewed');
  }
  if (imageCount === 0) throw new Error('No pinned images rendered');
  if (/^kind: (Ingress|Gateway)\s*$/mu.test(rendered) ||
      /^\s*type: (LoadBalancer|NodePort)\s*$/mu.test(rendered) ||
      /^\s*host(Network|Port):\s*(true|[1-9][0-9]*)\s*$/mu.test(rendered) ||
      /tailscale\.com\/funnel/u.test(rendered)) {
    throw new Error('Rendered package exposes a public endpoint');
  }
  await command('helm', ['install', release, 'infra/package/chart',
    '--kube-context', context, '--namespace', namespace, '--values', valuesFile,
    '--wait', '--timeout', '5m'], 360_000);
  const live = await kubectl(['-n', namespace, 'get',
    'services,ingresses,gateways.gateway.networking.k8s.io', '-o', 'json']);
  const resources = JSON.parse(live) as {
    items: Array<{ kind: string; spec?: { type?: string } }>;
  };
  for (const resource of resources.items) {
    if (resource.kind === 'Ingress' || resource.kind === 'Gateway' ||
        (resource.kind === 'Service' && resource.spec?.type !== 'ClusterIP')) {
      throw new Error('Live package exposes a public endpoint');
    }
  }
  const secret = await kubectl(['-n', namespace, 'get', 'secret',
    `sh.helm.release.v1.${release}.v1`, '-o', 'json']);
  owner.releaseSecretUid = JSON.parse(secret).metadata.uid as string;
  await saveOwner(owner);
}

export async function removePackage() {
  const owner = await readOwner();
  if (owner) await requireOwner();
  if (owner && !await getNamespace()) {
    await rm(recordFile, { force: true });
    return;
  }
  if (!owner) {
    if (await getNamespace()) throw new Error('Unrecorded package namespace is busy');
    return;
  }
  await verifyPackageOwner();
  const listed = await command('helm', ['list', '--all', '--kube-context', context,
    '--namespace', namespace, '--output', 'json']);
  const releases = JSON.parse(listed) as Array<{ name: string }>;
  for (const installed of releases) {
    if (installed.name !== release) throw new Error('Another Helm release uses this namespace');
  }
  if (owner.releaseSecretUid) {
    const secret = await kubectl(['-n', namespace, 'get', 'secret',
      `sh.helm.release.v1.${release}.v1`, '-o', 'json']);
    if (JSON.parse(secret).metadata.uid !== owner.releaseSecretUid) {
      throw new Error('Helm release belongs to another install');
    }
  }
  await command('helm', ['uninstall', release, '--kube-context', context,
    '--namespace', namespace, '--ignore-not-found']);
  await kubectl(['delete', 'namespace', namespace, '--wait=true']);
  await rm(recordFile, { force: true });
}
