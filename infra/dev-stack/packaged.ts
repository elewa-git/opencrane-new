import type { PackageReview } from './package-review.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { directory, root } from './config.ts';
import { readBoundedJson, readBoundedText } from './bounded-input.ts';
import { commandTimeout, type CommandLimits } from './command-limits.ts';
import { secondary, stackId } from './identity.ts';
import { targetConnection, targetRecorded } from './target.ts';
import { checkCnpgInstallation } from './cnpg.ts';
import { checkPackageHosts, type HostCheckOptions, type HostCheckRecord } from './package-hosts.ts';
import { checkPublicSettings, type PublicPackageValues } from '../package/public-settings.mjs';
import { checkNatsInputs } from '../package/check-nats-inputs.ts';
import { requireFleetStandInProvider } from './journey-guard.ts';

import { checkModelSecrets, type PackageModels } from '../package/model-settings.ts';

const execute = promisify(execFile);
const namespace = `opencrane-package-${stackId}`;
const release = `opencrane-package-${stackId}`;
const recordFile = `${directory}/package-owner.json`;
const chartDirectory = resolve(root, 'infra/package/chart');
const installIdLabel = 'opencrane.dev/install-id';
const secretKeys: Record<string, string[]> = {
  runtime: ['NATS_URL', 'DATABASE_URL', 'SILO_ID', 'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI', 'OIDC_COOKIE_SECRET',
    'OIDC_CLIENT_SECRET_ENV_VAR',
    'OIDC_EXPECTED_ORG_ID', 'OPENFGA_API_URL', 'OPENFGA_STORE_ID', 'OPENFGA_MODEL_ID',
    'PROJECTION_DATABASE_URL', 'HANDLER_DATABASE_URL', 'OWNER_BOOTSTRAP_READY',
    'MODEL_JWKS_FILE', 'MODEL_DECISION_URL', 'PACKAGE_OWNER_SUBJECT', 'DEV_OWNER_EMAIL',
    'MINIO_URL', 'MINIO_CREDENTIALS_FILE', 'SCANNER_URL', 'SCANNER_CA_FILE',
    'SCANNER_MANIFEST_DIGEST',
  ],
  runtimeFiles: [
    'ca.crt', 'command.crt', 'command.key', 'command.seed',
    'projection.crt', 'projection.key', 'projection.seed',
    'dispatcher.crt', 'dispatcher.key', 'dispatcher.seed',
    'token-signing-key.pem', 'zitadel-client-secret',
    'model-jwks.json', 'scanner-ca.crt'],
  postgres: ['POSTGRES_PASSWORD'],
  nats: ['nats.conf', 'ca.crt', 'server.crt', 'server.key', 'NATS_LISTEN',
    'NATS_STORE_DIR', 'NATS_CA_FILE', 'NATS_CERT_FILE', 'NATS_KEY_FILE',
    'NATS_COMMAND_NKEY', 'NATS_PROJECTION_NKEY', 'NATS_DISPATCHER_NKEY',
    'NATS_COMPUTER_NKEY', 'NATS_GATEWAY_NKEY'],
  openfga: ['OPENFGA_DATASTORE_ENGINE', 'OPENFGA_DATASTORE_URI'],
  bootstrap: ['POSTGRES_ADMIN_URL', 'PROJECTION_PASSWORD', 'SERVER_PASSWORD',
    'DISPATCHER_PASSWORD', 'OPENFGA_PASSWORD'],
  objects: ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'],
  scanner: ['signatures.json', 'release.json', 'server.key', 'server.crt', 'trust.json'],
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
  MINIO_URL: 'objects',
  SCANNER_URL: 'scanner',
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
  hostPreflight?: HostCheckRecord;
};
type PackageValues = Parameters<typeof checkCnpgInstallation>[0] & PublicPackageValues & {
  images: Record<string, string>;
  natsCluster?: { enabled: boolean };
  pilotRestore?: { enabled: boolean; backupId: string };
  models?: PackageModels;
};
type SecretData = { data?: Record<string, string> };
type ReleaseSecret = { metadata: { uid: string; labels?: Record<string, string> } };

async function command(program: string, args: string[], timeoutMs = 120_000, cwd = root,
  limits: CommandLimits = {}) {
  if (program === 'helm' && args.includes('--kube-context')) {
    const connection = await targetConnection(limits);
    const context = args[args.indexOf('--kube-context') + 1];
    if (connection.context !== context) {
      throw new Error('Package target changed');
    }
    if (connection.kubeconfig) args = ['--kubeconfig', connection.kubeconfig, ...args];
  }
  const env = { ...process.env };
  const configIndex = args.indexOf('--kubeconfig');
  if (configIndex !== -1) {
    env['KUBECONFIG'] = args[configIndex + 1];
    args = [...args.slice(0, configIndex), ...args.slice(configIndex + 2)];
  }
  try {
    const timeout = commandTimeout(timeoutMs, limits);
    const options = { cwd, env, timeout, signal: limits.signal, maxBuffer: 1_048_576 };
    const result = await execute(program, args, options);
    commandTimeout(timeoutMs, limits);
    return result.stdout.trim();
  } catch {
    // Discard dependency output because it may contain credentials.
    throw new Error('Package command failed');
  }
}

async function connectionArgs(expectedContext?: string, limits: CommandLimits = {}) {
  const connection = await targetConnection(limits);
  if (expectedContext && connection.context !== expectedContext) {
    throw new Error('Package target changed');
  }
  const options = [`--context=${connection.context}`];
  if (connection.kubeconfig) options.push('--kubeconfig', connection.kubeconfig);
  return options;
}

async function kubectl(args: string[], context?: string, timeoutMs = 120_000,
  limits: CommandLimits = {}) {
  const options = await connectionArgs(context, limits);
  return command('kubectl', [...options, ...args], timeoutMs, root, limits);
}

async function readOwner() {
  try {
    return await readBoundedJson(recordFile) as PackageOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function getNamespace(context?: string, limits: CommandLimits = {}) {
  const output = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json'],
    context, 120_000, limits);
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
  const record = await readBoundedText(`${directory}/stack-owner`);
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
  await command('node', [resolve(root, 'infra/package/prepare-scanner.mjs'), directory]);
}

export async function verifyPackageOwner(limits: CommandLimits = {}) {
  commandTimeout(120_000, limits);
  await requireOwner();
  const owner = await readOwner();
  const { context } = await targetConnection(limits);
  if (!owner || owner.worktree !== root || owner.slot !== stackId ||
      owner.context !== context || owner.namespace !== namespace || owner.release !== release) {
    throw new Error('Package ownership differs from the recorded namespace');
  }
  const found = await getNamespace(context, limits);
  if (!found || !ownedNamespace(found, owner)) {
    throw new Error('Package ownership differs from the recorded namespace');
  }
  return owner;
}

export async function packageConnectionArgs(owner: PackageOwner, limits: CommandLimits = {}) {
  const checked = await verifyPackageOwner(limits);
  if (checked.context !== owner.context || checked.namespaceUid !== owner.namespaceUid) {
    throw new Error('Package target changed');
  }
  const connection = await targetConnection(limits);
  if (connection.context !== owner.context) throw new Error('Package target changed');
  const args = [`--context=${connection.context}`];
  const environment = { ...process.env };
  if (connection.kubeconfig) environment['KUBECONFIG'] = connection.kubeconfig;
  return { args, environment };
}

async function ownedKubectl(owner: PackageOwner, args: string[], timeoutMs?: number,
  signal?: AbortSignal, deadline?: number) {
  // Keep dispatch delays and ownership checks inside the caller's original time limit.
  const limits: CommandLimits = { deadline: deadline ?? Date.now() + (timeoutMs ?? 120_000) };
  if (signal) {
    limits.signal = signal;
  }
  await packageConnectionArgs(owner, limits);
  return kubectl(args, owner.context, timeoutMs, limits);
}

function valuesLocation(valuesFile: string) {
  const absoluteFile = resolve(root, valuesFile);
  return { directory: dirname(absoluteFile), name: basename(absoluteFile) };
}

async function readReviewedValues(valuesFile: string) {
  const reviewFile = resolve(root, 'infra/package/reviewed-images.json');
  const location = valuesLocation(valuesFile);
  // Run inside the values directory so its private host path stays out of child arguments.
  await command('node', [resolve(root, 'infra/package/preflight.mjs'),
    location.name, reviewFile], 120_000, location.directory);
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as PackageValues;
  const review = JSON.parse(await readFile(reviewFile, 'utf8')) as PackageReview;
  // Use only pins that preflight has checked against successful exact-source CI output.
  // Keep all other roles bound to their fixed reviewed images during rendering.
  for (const role of ['scanner', 'server', 'web']) {
    review.images[role] = values.images[role]!;
  }
  const chart = await readFile('infra/package/chart/Chart.yaml', 'utf8');
  const version = chart.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/mu)?.[1];
  if (version !== review.chartVersion) throw new Error('Chart version is not reviewed');
  return { values, review };
}

function requiredSecretFields(name: string, tokenBootstrap: boolean) {
  const fields = secretKeys[name] ?? [];
  if (!tokenBootstrap) {
    return fields;
  }
  const privateFields = ['DEV_OWNER_EMAIL', 'PACKAGE_OWNER_SUBJECT',
    'OIDC_CLIENT_SECRET_ENV_VAR', 'zitadel-client-secret'];
  function publicField(field: string): boolean {
    return !privateFields.includes(field);
  }
  const required = fields.filter(publicField);
  if (name === 'runtimeFiles') {
    required.push('bootstrap-token.json');
  }
  return required;
}

function checkSecretFields(name: string, stored: SecretData, tokenBootstrap = false) {
  for (const key of requiredSecretFields(name, tokenBootstrap)) {
    if (!stored.data?.[key]) throw new Error(`Required secret field is absent: ${name}.${key}`);
  }
  if (tokenBootstrap && name === 'runtimeFiles' && stored.data?.['zitadel-client-secret']) {
    throw new Error('Public sign-in refuses a credential in shared runtime files');
  }
  if (!tokenBootstrap && name === 'runtime') {
    const encodedName = stored.data!['OIDC_CLIENT_SECRET_ENV_VAR']!;
    const secretName = Buffer.from(encodedName, 'base64').toString('utf8').trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(secretName) || !stored.data?.[secretName]) {
      throw new Error('OIDC client secret reference is absent');
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

function checkReplicaSettings(name: string, stored: SecretData, values: PackageValues) {
  if (name !== 'runtime' && name !== 'bootstrap') {
    return;
  }
  let replicas = '1';
  if (values.natsCluster?.enabled === true) {
    replicas = '3';
  }
  const expected = Buffer.from(replicas).toString('base64');
  for (const key of ['NATS_REPLICAS', 'COMMAND_NATS_REPLICAS']) {
    const encoded = stored.data?.[key];
    // Require runtime settings even when bootstrap supplies its own overrides.
    if (name === 'bootstrap' && encoded === undefined) {
      continue;
    }
    if (encoded !== expected) {
      throw new Error('Invalid package NATS replica settings');
    }
  }
}

async function checkClusterNodes(owner: PackageOwner) {
  if (!await targetRecorded() || owner.context === 'k3d-ocn') {
    throw new Error('NATS cluster requires a recorded isolated target');
  }
  await packageConnectionArgs(owner);
  const target = await readBoundedJson(`${directory}/target-owner.json`) as {
    id: string; nodes: Record<string, string>;
  };
  const output = await kubectl(['get', 'nodes', '-o', 'json'], owner.context);
  const nodes = JSON.parse(output) as { items: Array<{
    metadata: { name: string; uid: string; labels?: Record<string, string> };
    spec?: { unschedulable?: boolean; taints?: Array<{ effect: string }> };
    status?: { conditions?: Array<{ type: string; status: string }> };
  }> };
  const names = new Set<string>();
  const uids = new Set<string>();
  const hostnames = new Set<string>();
  for (const node of nodes.items) {
    if (!node.metadata.name || !node.metadata.uid ||
        target.nodes[node.metadata.name] !== node.metadata.uid ||
        node.metadata.labels?.['opencrane.dev/target-id'] !== target.id) {
      throw new Error('Target node ownership changed');
    }
    const hostname = node.metadata.labels?.['kubernetes.io/hostname'];
    let ready = false;
    for (const condition of node.status?.conditions ?? []) {
      if (condition.type === 'Ready' && condition.status === 'True') ready = true;
    }
    for (const taint of node.spec?.taints ?? []) {
      if (taint.effect === 'NoSchedule' || taint.effect === 'NoExecute') ready = false;
    }
    if (!ready || node.spec?.unschedulable || typeof hostname !== 'string' || !hostname) continue;
    names.add(node.metadata.name);
    uids.add(node.metadata.uid);
    hostnames.add(hostname);
  }
  if (nodes.items.length !== 3 || names.size !== 3 || uids.size !== 3 || hostnames.size !== 3) {
    throw new Error('NATS cluster needs three eligible distinct nodes');
  }
}

async function checkNamedSecrets(values: PackageValues, review: PackageReview, owner: PackageOwner,
  fleetTask: boolean) {
  const secrets: Record<string, SecretData> = {};
  for (const name of review.requiredSecrets) {
    const secret = values.secrets[name]!;
    const found = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret', secret,
      '--ignore-not-found', '-o', 'json']);
    if (!found) throw new Error(`Required secret is absent: ${name}`);
    const stored = JSON.parse(found) as SecretData;
    if (name === 'runtime' && !fleetTask && stored.data?.['OPENCRANE_FLEET_TASK'] !== undefined) {
      throw new Error('Package prepared by a fleet task requires a fleet installer');
    }
    checkReplicaSettings(name, stored, values);
    checkSecretFields(name, stored, values.exposure?.public?.enabled === true);
    checkModelSecrets(name, stored, values.models);
    secrets[name] = stored;
  }
  if (values.exposure?.public?.enabled === true) {
    const runtime = decodeSecret(secrets['runtime']!);
    const bootstrap = decodeSecret(secrets['bootstrap']!);
    checkPublicSettings(values, runtime);
    checkPublicSettings(values, { ...runtime, ...bootstrap });
    const found = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret',
      'package-sign-in', '--ignore-not-found', '-o', 'json']);
    const signIn = found ? JSON.parse(found) as SecretData : undefined;
    if (!signIn?.data?.['credential']) {
      throw new Error('Public sign-in credential is absent');
    }
  }
  if (values.models?.qualification) {
    const found = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret',
      'model-qualification', '--ignore-not-found', '-o', 'json']);
    const stored = found ? JSON.parse(found) as SecretData : undefined;
    const encoded = stored?.data?.['credential'];
    const credentialBytes = encoded ? Buffer.from(encoded, 'base64') : undefined;
    const credential = credentialBytes?.toString('utf8');
    if (!credential || !/^[a-f0-9]{64}$/u.test(credential)) {
      throw new Error('Qualification credential is absent');
    }
  }
  return secrets;
}

function decodeSecret(secret: SecretData) {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(secret.data ?? {})) {
    settings[name] = Buffer.from(value, 'base64').toString('utf8');
  }
  return settings;
}

async function checkRenderedPackage(valuesFile: string, review: PackageReview, fleetSetting: string) {
  const location = valuesLocation(valuesFile);
  const args = ['template', release, chartDirectory, '--namespace', namespace,
    '--values', location.name, '--set', fleetSetting];
  const rendered = await command('helm', args, 120_000, location.directory);
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

async function checkLiveExposure(owner: PackageOwner) {
  const gatewayResources = await ownedKubectl(owner, ['api-resources',
    '--api-group=gateway.networking.k8s.io', '--no-headers', '--output=name']);
  const resourcesToCheck = ['services', 'ingresses'];
  if (gatewayResources.split('\n').includes('gateways.gateway.networking.k8s.io')) {
    resourcesToCheck.push('gateways.gateway.networking.k8s.io');
  }
  const live = await ownedKubectl(owner, ['-n', namespace, 'get',
    resourcesToCheck.join(','), '-o', 'json']);
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

async function releaseSecret(owner: PackageOwner) {
  const secret = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret',
    `sh.helm.release.v1.${release}.v1`, '--ignore-not-found', '-o', 'json']);
  if (!secret) return undefined;
  return JSON.parse(secret) as ReleaseSecret;
}

function requireOwnedRelease(secret: ReleaseSecret | undefined, owner: PackageOwner) {
  if (!secret?.metadata.uid || !owner.installId ||
      secret.metadata.labels?.[installIdLabel] !== owner.installId) {
    throw new Error('Helm release ownership was not recorded');
  }
}

async function checkedRelease() {
  const owner = await verifyPackageOwner();
  const uid = await ownedReleaseSecretUid(owner);
  if (!uid || uid !== owner.releaseSecretUid) {
    throw new Error('Helm release belongs to another install');
  }
  return owner;
}

async function releaseCommand(owner: PackageOwner, args: string[], timeoutMs?: number) {
  await packageConnectionArgs(owner);
  return command('helm', [...args, '--kube-context', owner.context, '--namespace', owner.namespace],
    timeoutMs);
}

type PilotUpgradeValues = {
  chartVersion?: string;
  exposure?: { public?: { enabled?: boolean } };
  pilotRestore?: { enabled?: boolean };
  images?: { server?: string };
  secrets?: { scanner?: string };
};

async function pilotUpgradeValues(owner: PackageOwner) {
  const current = await releaseCommand(owner, ['get', 'values', owner.release, '-o', 'json']);
  const values = JSON.parse(current) as PilotUpgradeValues;
  const reviewFile = resolve(root, 'infra/package/reviewed-images.json');
  const review = await readBoundedJson(reviewFile) as PackageReview;
  if (values.chartVersion !== review.chartVersion ||
      !values.exposure?.public?.enabled || values.pilotRestore?.enabled) {
    throw new Error('Application updates need an installed pilot with the same chart version');
  }
  const original = await releaseCommand(owner, ['get', 'values', owner.release, '--revision', '1',
    '-o', 'json']);
  const first = JSON.parse(original) as PilotUpgradeValues;
  const bootstrapImage = first.images?.server;
  if (!bootstrapImage || !/@sha256:[a-f0-9]{64}$/u.test(bootstrapImage)) {
    throw new Error('The original bootstrap image is not pinned');
  }
  const scannerSecret = values.secrets?.scanner;
  if (!scannerSecret || !/^[a-z0-9][a-z0-9.-]*$/u.test(scannerSecret)) {
    throw new Error('The pilot scanner Secret is missing');
  }
  return { bootstrapImage, scannerSecret, serverImage: values.images?.server };
}

async function checkBackupIsIdle(owner: PackageOwner) {
  const active = await ownedKubectl(owner, ['-n', namespace, 'get', 'cronjob', 'pilot-backup',
    '-o', 'jsonpath={.status.active[*].uid}']);
  if (active) throw new Error('Wait for the scheduled backup to finish before changing the release');
}

async function prepareUpgradeScanner(owner: PackageOwner, previousName: string, approvals: string) {
  const { publishApprovedScanner } = await import('../package/publish-approved-images.mjs');
  const approval = await publishApprovedScanner(approvals);
  const name = `package-scanner-${approval.approvedSha}`;
  const previousText = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret', previousName,
    '-o', 'json']);
  const previous = JSON.parse(previousText) as SecretData;
  checkSecretFields('scanner', previous);
  const data = { ...previous.data };
  for (const file of ['signatures.json', 'release.json']) {
    const contents = await readBoundedText(resolve(approval.destination, file));
    data[file] = Buffer.from(contents).toString('base64');
  }
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name }, immutable: true, data };
  const foundText = await ownedKubectl(owner, ['-n', namespace, 'get', 'secret', name,
    '--ignore-not-found', '-o', 'json']);
  if (foundText) {
    const found = JSON.parse(foundText) as SecretData & { immutable?: boolean };
    if (!found.immutable || !isDeepStrictEqual(found.data, data)) {
      throw new Error('The new scanner Secret already exists with different settings');
    }
  } else {
    await createUpgradeSecret(owner, secret);
  }
  return { ...approval, name };
}

async function createUpgradeSecret(owner: PackageOwner, secret: unknown) {
  const temporary = await mkdtemp(`${directory}/scanner-upgrade-`);
  try {
    await writeFile(resolve(temporary, 'secret.json'), JSON.stringify(secret), { mode: 0o600 });
    await packageConnectionArgs(owner);
    const connection = await connectionArgs(owner.context);
    await command('kubectl', [...connection, '-n', namespace, 'create', '-f', 'secret.json'],
      30_000, temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function upgradePackage() {
  const { publishApprovedApplication } = await import('../package/publish-approved-images.mjs');
  const owner = await checkedRelease();
  const { bootstrapImage, scannerSecret, serverImage } = await pilotUpgradeValues(owner);
  await command('git', ['diff', '--quiet', 'HEAD', '--', 'infra/package/chart']);
  const revision = await command('git', ['rev-parse', 'HEAD']);
  const approvals = resolve(directory, 'release-approvals', revision);
  const approval = await publishApprovedApplication(approvals);
  if (approval.image === serverImage) throw new Error('This application image is already installed');
  await checkLiveExposure(owner);
  await checkBackupIsIdle(owner);
  const scanner = await prepareUpgradeScanner(owner, scannerSecret, approvals);
  await checkBackupIsIdle(owner);
  // Keep the original release Secret for ownership checks and leave the finished Job intact.
  await releaseCommand(owner, ['upgrade', owner.release, chartDirectory, '--reuse-values',
    '--set-string', `images.server=${approval.image}`, '--set-string', `images.web=${approval.image}`,
    '--set-string', `images.scanner=${scanner.image}`,
    '--set-string', `scanner.approvedSha=${scanner.approvedSha}`,
    '--set-string', `secrets.scanner=${scanner.name}`,
    '--set-string', `bootstrapImage=${bootstrapImage}`, '--history-max', '0',
    '--atomic', '--timeout', '8m'], 1_020_000);
  await checkLiveExposure(owner);
  console.log(`PASS applied application approval from GitHub run ${approval.runId}`);
}

export async function rollbackPackage(revision: string) {
  if (!/^[1-9][0-9]*$/u.test(revision)) throw new Error('Select a recorded Helm revision');
  const owner = await checkedRelease();
  await checkBackupIsIdle(owner);
  await releaseCommand(owner, ['rollback', owner.release, revision, '--history-max', '0',
    '--wait', '--timeout', '8m'], 540_000);
  await checkLiveExposure(owner);
}

async function ownedReleaseSecretUid(owner: PackageOwner) {
  const secret = await releaseSecret(owner);
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

async function waitForBootstrap(owner: PackageOwner) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const output = await ownedKubectl(owner, ['-n', namespace, 'get', 'job', 'bootstrap', '-o', 'json']);
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

async function configureComputerGateway(owner: PackageOwner) {
  const output = await ownedKubectl(owner, ['-n', namespace, 'get', 'service', 'server', '-o', 'json']);
  const service = JSON.parse(output) as { spec?: { type?: string; clusterIP?: string } };
  const address = service.spec?.clusterIP;
  if (service.spec?.type !== 'ClusterIP' || !address || isIP(address) === 0) {
    throw new Error('The private gateway Service has no ClusterIP');
  }
  const patch = JSON.stringify({ data: { gateway: `http://${address}:43000` } });
  await ownedKubectl(owner, ['-n', namespace, 'patch', 'configmap', 'computer-runtime',
    '--type=merge', '-p', patch]);
}

export async function installPackage(valuesFile: string) {
  const owner = await verifyPackageOwner();
  function checkedKubectl(args: string[], timeoutMs?: number, signal?: AbortSignal,
    deadline?: number) {
    return ownedKubectl(owner, args, timeoutMs, signal, deadline);
  }
  const { values, review } = await readReviewedValues(valuesFile);
  const fleetTask = process.env['OPENCRANE_FLEET_TASK'] !== undefined;
  requireFleetStandInProvider(values.models?.mode === 'provider' && !values.models.qualification);
  // Give the models container the same restriction even if preparation had no marker.
  const fleetSetting = `models.fleetTask=${fleetTask}`;
  const hostOptions: HostCheckOptions = {
    command: checkedKubectl, namespace, image: values.images['server']!,
    localCommand: command };
  const override = process.env['OPENCRANE_ACCEPT_DEV_HOST_RISK'];
  if (override !== undefined) hostOptions.override = override;
  owner.hostPreflight = await checkPackageHosts(hostOptions);
  await saveOwner(owner);
  await checkCnpgInstallation(values, namespace, checkedKubectl);
  const secrets = await checkNamedSecrets(values, review, owner, fleetTask);
  if (values.natsCluster?.enabled) {
    await checkClusterNodes(owner);
    const { checkPreparedNatsRoutes } = await import('../package/prepare-nats-routes.ts');
    await checkPreparedNatsRoutes(valuesFile, owner);
  }
  await checkNatsInputs(secrets);
  await checkRenderedPackage(valuesFile, review, fleetSetting);
  if (await releaseSecret(owner)) throw new Error('A Helm release already uses this namespace');
  // Save the identity before Helm runs so interrupted cleanup can recognise this install.
  owner.installId = randomUUID();
  await saveOwner(owner);
  try {
    const location = valuesLocation(valuesFile);
    await packageConnectionArgs(owner);
    await command('helm', ['install', release, chartDirectory,
      '--kube-context', owner.context, '--namespace', namespace, '--values', location.name,
      '--labels', `${installIdLabel}=${owner.installId}`,
      '--wait=false', '--set', fleetSetting], 180_000, location.directory);
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
  await configureComputerGateway(owner);
  if (!values.pilotRestore?.enabled) await waitForBootstrap(owner);
  const storage = ['objects'];
  if (values.pilotRestore?.enabled) storage.push('nats', 'postgres');
  for (const service of storage) {
    await checkedKubectl(['-n', namespace, 'rollout', 'status', `statefulset/${service}`,
      '--timeout=120s'], 150_000);
  }
  const deployments = [
    'scanner', 'server', 'web', 'worker-members', 'worker-mcp-catalogue', 'worker-computers',
    'worker-conversations', 'worker-files', 'worker-budgets', 'worker-audit',
    'worker-dispatcher', ...(values.models?.mode === 'provider' ? ['worker-routines'] : []),
  ];
  for (const deployment of deployments) {
    await checkedKubectl(['-n', namespace, 'rollout', 'status', `deployment/${deployment}`,
      '--timeout=180s'], 240_000);
  }
  await checkLiveExposure(owner);
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
  const secret = await releaseSecret(owner);
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
