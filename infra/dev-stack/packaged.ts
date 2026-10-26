import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { directory, root } from './config.ts';
import { secondary, stackId } from './identity.ts';
import { targetConnection, targetRecorded } from './target.ts';
import { checkCnpgInstallation } from './cnpg.ts';

const execute = promisify(execFile);
const namespace = `opencrane-package-${stackId}`;
const release = `opencrane-package-${stackId}`;
const recordFile = `${directory}/package-owner.json`;
const installIdLabel = 'opencrane.dev/install-id';
const secretKeys: Record<string, string[]> = {
  runtime: ['NATS_URL', 'DATABASE_URL', 'SILO_ID', 'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_COOKIE_SECRET',
    'OIDC_CLIENT_SECRET_ENV_VAR',
    'OIDC_EXPECTED_ORG_ID', 'OPENFGA_API_URL', 'OPENFGA_STORE_ID', 'OPENFGA_MODEL_ID',
    'PROJECTION_DATABASE_URL', 'HANDLER_DATABASE_URL', 'OWNER_BOOTSTRAP_READY',
    'CONVERSATION_KEYS_DIR', 'CONVERSATION_WRAP_KEY_FILE',
    'MODEL_UPSTREAM', 'MODEL_KEY_FILE',
    'MODEL_JWKS_FILE', 'MODEL_DECISION_URL', 'PACKAGE_OWNER_SUBJECT', 'DEV_OWNER_EMAIL',
  ],
  runtimeFiles: [
    'conversation-wrap-key',
    'ca.crt', 'command.crt', 'command.key', 'command.seed',
    'projection.crt', 'projection.key', 'projection.seed',
    'dispatcher.crt', 'dispatcher.key', 'dispatcher.seed',
    'token-signing-key.pem', 'zitadel-client-secret',
    'model-jwks.json', 'model-stub-key'],
  postgres: ['POSTGRES_PASSWORD'],
  nats: ['nats.conf', 'ca.crt', 'server.crt', 'server.key', 'NATS_LISTEN',
    'NATS_STORE_DIR', 'NATS_CA_FILE', 'NATS_CERT_FILE', 'NATS_KEY_FILE',
    'NATS_COMMAND_NKEY', 'NATS_PROJECTION_NKEY', 'NATS_DISPATCHER_NKEY',
    'NATS_COMPUTER_NKEY', 'NATS_GATEWAY_NKEY'],
  openfga: ['OPENFGA_DATASTORE_ENGINE', 'OPENFGA_DATASTORE_URI'],
  bootstrap: ['POSTGRES_ADMIN_URL', 'PROJECTION_PASSWORD', 'SERVER_PASSWORD',
    'DISPATCHER_PASSWORD', 'OPENFGA_PASSWORD'],
};
const privateHosts: Record<string, string> = {
  NATS_URL: 'nats',
  DATABASE_URL: 'postgres',
  OPENFGA_API_URL: 'openfga',
  OPENFGA_DATASTORE_URI: 'postgres',
  PROJECTION_DATABASE_URL: 'postgres',
  HANDLER_DATABASE_URL: 'postgres',
  POSTGRES_ADMIN_URL: 'postgres',
  MODEL_DECISION_URL: 'server',
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
  installId?: string;
};
type PackageValues = Parameters<typeof checkCnpgInstallation>[0];
type PackageReview = {
  requiredSecrets: string[];
  chartVersion: string;
  images: Record<string, string>;
};
type SecretData = { data?: Record<string, string> };
type ReleaseSecret = { metadata: { uid: string; labels?: Record<string, string> } };

async function command(program: string, args: string[], timeoutMs = 120_000) {
  if (program === 'helm' && args.includes('--kube-context')) {
    const connection = await targetConnection();
    const context = args[args.indexOf('--kube-context') + 1];
    if (connection.context !== context) {
      throw new Error('Package target changed');
    }
    if (connection.kubeconfig) args = ['--kubeconfig', connection.kubeconfig, ...args];
  }
  try {
    const result = await execute(program, args, { cwd: root, timeout: timeoutMs });
    return result.stdout.trim();
  } catch {
    // Discard dependency output because it may contain credentials.
    throw new Error('Package command failed');
  }
}

async function connectionArgs(expectedContext?: string) {
  const connection = await targetConnection();
  if (expectedContext && connection.context !== expectedContext) {
    throw new Error('Package target changed');
  }
  const options = [`--context=${connection.context}`];
  if (connection.kubeconfig) options.push('--kubeconfig', connection.kubeconfig);
  return options;
}

async function kubectl(args: string[], context?: string, timeoutMs = 120_000) {
  const options = await connectionArgs(context);
  return command('kubectl', [...options, ...args], timeoutMs);
}

async function readOwner() {
  try {
    return JSON.parse(await readFile(recordFile, 'utf8')) as PackageOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function getNamespace(context?: string) {
  const output = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json'],
    context);
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
    if (await targetRecorded()) return true;
    const owner = await readOwner();
    const found = await getNamespace(owner?.context);
    if (!found) return false;
    if (owner?.worktree === root && ownedNamespace(found, owner)) await saveOwner(owner);
    return true;
  } catch {
    // Keep the slot claimed when Kubernetes cannot prove that its resources are gone.
    return true;
  }
}

export async function requireOwner() {
  if (!secondary) throw new Error('A package needs a secondary slot');
  const record = await readFile(`${directory}/stack-owner`, 'utf8');
  if (!record.startsWith(`worktree=${root}\n`)) throw new Error('This worktree does not own the slot');
}

export async function preparePackage() {
  await requireOwner();
  const { context } = await targetConnection();
  if (await getNamespace(context)) throw new Error('Package namespace already exists');
  await kubectl(['create', 'namespace', namespace], context);
  const found = await getNamespace(context);
  if (!found) throw new Error('Package namespace was not created');
  await kubectl(['annotate', 'namespace', namespace,
    `opencrane.dev/worktree=${root}`, `opencrane.dev/slot=${stackId}`], context);
  const owner: PackageOwner = {
    worktree: root, slot: stackId, context, namespace,
    namespaceUid: found.metadata.uid, release, heartbeatAt: '',
  };
  await saveOwner(owner);
}

export async function verifyPackageOwner() {
  await requireOwner();
  const owner = await readOwner();
  const { context } = await targetConnection();
  if (!owner || owner.worktree !== root || owner.slot !== stackId ||
      owner.context !== context || owner.namespace !== namespace || owner.release !== release) {
    throw new Error('Package ownership differs from the recorded namespace');
  }
  const found = await getNamespace(context);
  if (!found || !ownedNamespace(found, owner)) {
    throw new Error('Package ownership differs from the recorded namespace');
  }
  return owner;
}

export async function packageConnectionArgs(owner: PackageOwner) {
  const checked = await verifyPackageOwner();
  if (checked.context !== owner.context || checked.namespaceUid !== owner.namespaceUid) {
    throw new Error('Package target changed');
  }
  return connectionArgs(owner.context);
}

async function readReviewedValues(valuesFile: string) {
  const reviewFile = 'infra/package/reviewed-images.json';
  await command('node', ['infra/package/preflight.mjs', valuesFile, reviewFile]);
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as PackageValues;
  const review = JSON.parse(await readFile(reviewFile, 'utf8')) as PackageReview;
  const chart = await readFile('infra/package/chart/Chart.yaml', 'utf8');
  const version = chart.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/mu)?.[1];
  if (version !== review.chartVersion) throw new Error('Chart version is not reviewed');
  return { values, review };
}

function checkSecretFields(name: string, stored: SecretData) {
  for (const key of secretKeys[name] ?? []) {
    if (!stored.data?.[key]) throw new Error(`Required secret field is absent: ${name}.${key}`);
  }
  if (name === 'runtime') {
    const encodedName = stored.data!['OIDC_CLIENT_SECRET_ENV_VAR']!;
    const secretName = Buffer.from(encodedName, 'base64').toString('utf8').trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(secretName) || !stored.data?.[secretName]) {
      throw new Error('OIDC client secret reference is absent');
    }
    const upstream = Buffer.from(stored.data!['MODEL_UPSTREAM']!, 'base64').toString('utf8');
    if (upstream !== '127.0.0.1:43003') {
      throw new Error('The package model must use its local stub');
    }
  }
  // Read secret bytes only in memory; report field names, never endpoint credentials.
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

async function checkNamedSecrets(values: PackageValues, review: PackageReview, context: string) {
  for (const name of review.requiredSecrets) {
    const secret = values.secrets[name]!;
    const found = await kubectl(['-n', namespace, 'get', 'secret', secret,
      '--ignore-not-found', '-o', 'json'], context);
    if (!found) throw new Error(`Required secret is absent: ${name}`);
    const stored = JSON.parse(found) as SecretData;
    checkSecretFields(name, stored);
  }
}

async function checkRenderedPackage(valuesFile: string, review: PackageReview) {
  const rendered = await command('helm', ['template', release, 'infra/package/chart',
    '--namespace', namespace, '--values', valuesFile]);
  const reviewedImages = new Set(Object.values(review.images));
  const renderedImages = rendered.matchAll(/^\s*"?(image|imageName)"?:\s*"?([^",\n]+)"?,?\s*$/gmu);
  let imageCount = 0;
  for (const image of renderedImages) {
    imageCount++;
    if (!reviewedImages.has(image[2]!) ||
        (image[1] === 'imageName' && image[2] !== review.images['postgres'])) {
      throw new Error('Rendered image is not reviewed');
    }
  }
  if (imageCount === 0) throw new Error('No pinned images rendered');
  if (/^kind: (Ingress|Gateway)\s*$/mu.test(rendered) ||
      /^\s*type: (LoadBalancer|NodePort)\s*$/mu.test(rendered) ||
      /^\s*host(Network|Port):\s*(true|[1-9][0-9]*)\s*$/mu.test(rendered) ||
      /tailscale\.com\/funnel/u.test(rendered)) {
    throw new Error('Rendered package exposes a public endpoint');
  }
}

async function checkLiveExposure(context: string) {
  const gatewayResources = await kubectl(['api-resources',
    '--api-group=gateway.networking.k8s.io', '--no-headers', '--output=name'], context);
  const resourcesToCheck = ['services', 'ingresses'];
  if (gatewayResources.split('\n').includes('gateways.gateway.networking.k8s.io')) {
    resourcesToCheck.push('gateways.gateway.networking.k8s.io');
  }
  const live = await kubectl(['-n', namespace, 'get',
    resourcesToCheck.join(','), '-o', 'json'], context);
  const resources = JSON.parse(live) as {
    items: Array<{ kind: string; spec?: { type?: string } }>;
  };
  for (const resource of resources.items) {
    if (resource.kind === 'Ingress' || resource.kind === 'Gateway' ||
        (resource.kind === 'Service' && resource.spec?.type !== 'ClusterIP')) {
      throw new Error('Live package exposes a public endpoint');
    }
  }
}

async function releaseSecret(context: string) {
  const secret = await kubectl(['-n', namespace, 'get', 'secret',
    `sh.helm.release.v1.${release}.v1`, '--ignore-not-found', '-o', 'json'], context);
  if (!secret) return undefined;
  return JSON.parse(secret) as ReleaseSecret;
}

function requireOwnedRelease(secret: ReleaseSecret | undefined, owner: PackageOwner) {
  if (!secret?.metadata.uid || !owner.installId ||
      secret.metadata.labels?.[installIdLabel] !== owner.installId) {
    throw new Error('Helm release ownership was not recorded');
  }
}

async function ownedReleaseSecretUid(owner: PackageOwner) {
  const secret = await releaseSecret(owner.context);
  if (!secret) return undefined;
  requireOwnedRelease(secret, owner);
  return secret.metadata.uid;
}

function completed(condition: { type: string; status: string }) {
  return condition.type === 'Complete' && condition.status === 'True';
}

function failed(condition: { type: string; status: string }) {
  return condition.type === 'Failed' && condition.status === 'True';
}

async function waitForBootstrap(context: string) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const output = await kubectl(['-n', namespace, 'get', 'job', 'bootstrap', '-o', 'json'],
      context);
    const job = JSON.parse(output) as {
      status?: { conditions?: Array<{ type: string; status: string }> };
    };
    const conditions = job.status?.conditions ?? [];
    if (conditions.some(completed)) return;
    if (conditions.some(failed)) {
      throw new Error('Package bootstrap Job failed');
    }
    await delay(2000);
  }
  throw new Error('Package bootstrap Job timed out');
}

async function configureComputerGateway(context: string) {
  const output = await kubectl(['-n', namespace, 'get', 'service', 'server', '-o', 'json'],
    context);
  const service = JSON.parse(output) as { spec?: { type?: string; clusterIP?: string } };
  const address = service.spec?.clusterIP;
  if (service.spec?.type !== 'ClusterIP' || !address || isIP(address) === 0) {
    throw new Error('The private gateway Service has no ClusterIP');
  }
  const patch = JSON.stringify({ data: { gateway: `http://${address}:43000` } });
  await kubectl(['-n', namespace, 'patch', 'configmap', 'computer-runtime',
    '--type=merge', '-p', patch], context);
}

export async function installPackage(valuesFile: string) {
  const { values, review } = await readReviewedValues(valuesFile);
  const owner = await verifyPackageOwner();
  const context = owner.context;
  function checkedKubectl(args: string[], timeoutMs?: number) {
    return kubectl(args, context, timeoutMs);
  }
  await checkCnpgInstallation(values, namespace, checkedKubectl);
  await checkNamedSecrets(values, review, context);
  await checkRenderedPackage(valuesFile, review);
  if (await releaseSecret(context)) throw new Error('A Helm release already uses this namespace');
  // Save the identity before Helm runs so interrupted cleanup can recognise this install.
  owner.installId = randomUUID();
  await saveOwner(owner);
  try {
    await command('helm', ['install', release, 'infra/package/chart',
      '--kube-context', context, '--namespace', namespace, '--values', valuesFile,
      '--labels', `${installIdLabel}=${owner.installId}`,
      '--wait=false'], 180_000);
  } catch (error) {
    const releaseUid = await ownedReleaseSecretUid(owner);
    if (releaseUid) owner.releaseSecretUid = releaseUid;
    else delete owner.releaseSecretUid;
    await saveOwner(owner);
    throw error;
  }
  const releaseUid = await ownedReleaseSecretUid(owner);
  if (releaseUid) owner.releaseSecretUid = releaseUid;
  else delete owner.releaseSecretUid;
  if (!owner.releaseSecretUid) throw new Error('Helm did not record its release');
  await saveOwner(owner);
  await configureComputerGateway(context);
  await waitForBootstrap(context);
  const deployments = [
    'server', 'web', 'worker-members', 'worker-mcp-catalogue', 'worker-computers',
    'worker-conversations', 'worker-files', 'worker-budgets', 'worker-audit',
    'worker-dispatcher',
  ];
  for (const deployment of deployments) {
    await kubectl(['-n', namespace, 'rollout', 'status', `deployment/${deployment}`,
      '--timeout=180s'], context, 240_000);
  }
  await checkLiveExposure(context);
}

export async function removePackage(checkUnrecordedNamespace = true) {
  const owner = await readOwner();
  if (!owner) {
    // Ordinary Compose teardown must not depend on an unrelated Kubernetes check.
    if (checkUnrecordedNamespace && await getNamespace()) {
      throw new Error('Unrecorded package namespace is busy');
    }
    return;
  }
  await requireOwner();
  const { context } = await targetConnection();
  if (owner.worktree !== root || owner.slot !== stackId || owner.context !== context ||
      owner.namespace !== namespace || owner.release !== release) {
    throw new Error('Package ownership differs from the recorded target');
  }
  if (!await getNamespace(context)) {
    await rm(recordFile, { force: true });
    return;
  }
  await verifyPackageOwner();
  const listed = await command('helm', ['list', '--all', '--kube-context', context,
    '--namespace', namespace, '--output', 'json']);
  const releases = JSON.parse(listed) as Array<{ name: string }>;
  for (const installed of releases) {
    if (installed.name !== release) throw new Error('Another Helm release uses this namespace');
  }
  const secret = await releaseSecret(context);
  if (releases.length > 0 || secret) {
    requireOwnedRelease(secret, owner);
    if (!owner.releaseSecretUid) {
      // Keep the recovered UID so a later retry checks the same release.
      owner.releaseSecretUid = secret!.metadata.uid;
      await saveOwner(owner);
    }
  }
  if (owner.releaseSecretUid) {
    if (secret?.metadata.uid !== owner.releaseSecretUid) {
      throw new Error('Helm release belongs to another install');
    }
  }
  // Let the computer controller release its Pod and volumes while its warm pool still exists.
  await kubectl(['-n', namespace, 'delete', 'sandboxclaims', '--all',
    '--ignore-not-found', '--wait=true', '--timeout=120s'], context, 150_000);
  await command('helm', ['uninstall', release, '--kube-context', context,
    '--namespace', namespace, '--ignore-not-found']);
  await kubectl(['delete', 'namespace', namespace, '--wait=true'], context);
  await rm(recordFile, { force: true });
}
