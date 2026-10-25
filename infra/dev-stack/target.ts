import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { directory, exists, root } from './config.ts';
import { secondary, stackId } from './identity.ts';

const execute = promisify(execFile);
const name = `opencrane-target-${stackId}`;
const context = `k3d-${name}`;
const recordFile = `${directory}/target-owner.json`;
const kubeconfig = `${directory}/target.kubeconfig`;
const label = 'opencrane.dev/target-id';
const storage = `${directory}/target-data`;
const volumePaths = ['/var/lib/kubelet', '/var/lib/rancher/k3s', '/var/lib/cni', '/var/log'];
const image = 'docker.io/rancher/k3s@sha256:' +
  'd33b1973401a60410681d66c007f5c3a51d565a7c03608904764aef3321fee4d';
type Resource = {
  Id: string;
  Labels?: Record<string, string>;
  Config?: { Labels?: Record<string, string> };
  Containers?: Record<string, unknown>;
  Mounts?: Array<{ Type: string }>;
};
type Node = { metadata: { name: string; uid: string; labels?: Record<string, string> } };
type Target = {
  worktree: string;
  slot: string;
  name: string;
  context: string;
  id: string;
  containers: string[];
  network?: string;
  nodes: Record<string, string>;
};

async function command(program: string, args: string[], timeout = 10_000) {
  try {
    const result = await execute(program, args, { cwd: root, timeout, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    // Discard command output: kubeconfig and upstream errors can contain credentials.
    throw new Error('Target command failed; ownership remains reserved');
  }
}

export async function targetRecorded() {
  return secondary && await exists(recordFile);
}

async function readTarget() {
  const owner = await readFile(`${directory}/stack-owner`, 'utf8');
  if (!secondary || !owner.startsWith(`worktree=${root}\n`)) {
    throw new Error('This worktree does not own the target slot');
  }
  const record = JSON.parse(await readFile(recordFile, 'utf8')) as Target;
  if (record.worktree !== root || record.slot !== stackId || record.name !== name ||
      record.context !== context || !/^[a-f0-9-]{36}$/u.test(record.id)) {
    throw new Error('Target ownership differs from the recorded slot');
  }
  return record;
}

async function saveTarget(record: Target) {
  await writeFile(`${recordFile}.tmp`, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(`${recordFile}.tmp`, recordFile);
}

function ids(output: string) {
  if (!output) return [];
  return output.split(/\s+/u);
}

async function resources() {
  const containers = ids(await command('docker', ['ps', '-a', '--quiet', '--no-trunc',
    '--filter', `label=k3d.cluster=${name}`]));
  const named = ids(await command('docker', ['ps', '-a', '--quiet', '--no-trunc',
    '--filter', `name=^/k3d-${name}-`]));
  for (const container of named) {
    if (!containers.includes(container)) containers.push(container);
  }
  const networks = ids(await command('docker', ['network', 'ls', '--quiet', '--no-trunc',
    '--filter', `name=^${name}$`]));
  return { containers, networks };
}

function isVolume(mount: { Type: string }) {
  return mount.Type === 'volume';
}

async function inspect(record: Target) {
  const found = await resources();
  if (found.networks.length > 1 || found.containers.length > 3) {
    throw new Error('Unexpected target resources');
  }
  if (found.networks.length) {
    const output = await command('docker', ['network', 'inspect', ...found.networks]);
    const [network] = JSON.parse(output) as Resource[];
    if (!network || network.Labels?.[label] !== record.id ||
        (record.network && record.network !== network.Id)) {
      throw new Error('Target network ownership changed');
    }
    for (const container of Object.keys(network.Containers ?? {})) {
      if (!found.containers.includes(container)) throw new Error('Foreign container uses target');
    }
    record.network = network.Id;
  }
  if (found.containers.length) {
    const output = await command('docker', ['inspect', ...found.containers]);
    const containers = JSON.parse(output) as Resource[];
    if (containers.length !== found.containers.length) throw new Error('Target inspection incomplete');
    for (const container of containers) {
      if (container.Mounts?.some(isVolume)) throw new Error('Unrecorded Docker volume');
      if (container.Config?.Labels?.[label] !== record.id ||
          (record.containers.length && !record.containers.includes(container.Id))) {
        throw new Error('Target container ownership changed');
      }
    }
  }
  return found;
}

async function readNodes(record: Target) {
  const output = await command('kubectl', ['--kubeconfig', kubeconfig, '--context', context,
    '--request-timeout=8s', 'get', 'nodes', '-o', 'json']);
  const { items } = JSON.parse(output) as { items: Node[] };
  const nodes: Record<string, string> = {};
  for (const node of items) {
    const metadata = node.metadata;
    if (!metadata.uid || metadata.labels?.[label] !== record.id ||
        (Object.keys(record.nodes).length && record.nodes[metadata.name] !== metadata.uid)) {
      throw new Error('Target node ownership changed');
    }
    nodes[metadata.name] = metadata.uid;
  }
  if (items.length !== 3 || Object.keys(nodes).length !== 3) {
    throw new Error('Target needs three distinct nodes');
  }
  return nodes;
}

export async function targetConnection() {
  if (!await targetRecorded()) return { context: 'k3d-ocn', kubeconfig: undefined };
  const record = await readTarget();
  const found = await inspect(record);
  if (found.containers.length !== 3 || found.networks.length !== 1 ||
      Object.keys(record.nodes).length !== 3) throw new Error('Target creation is incomplete');
  await readNodes(record);
  return { context, kubeconfig };
}

export async function createTarget() {
  if (await targetRecorded()) {
    await targetConnection();
    return;
  }
  const found = await resources();
  if (found.containers.length || found.networks.length) throw new Error('Target name is occupied');
  const record: Target = { worktree: root, slot: stackId, name, context,
    id: randomUUID(), containers: [], nodes: {} };
  // Reserve the attempt before Docker can create even its first resource.
  await saveTarget(record);
  record.network = await command('docker', ['network', 'create', '--label',
    `${label}=${record.id}`, name]);
  await saveTarget(record);
  const volumes: string[] = [];
  for (const node of ['server:0', 'agent:0', 'agent:1']) {
    for (const path of volumePaths) {
      const source = `${storage}/${node.replace(':', '-')}${path}`;
      await mkdir(source, { recursive: true, mode: 0o700 });
      volumes.push('--volume', `${source}:${path}@${node}`);
    }
  }
  await command('k3d', ['cluster', 'create', name, '--servers', '1', '--agents', '2',
    '--image', image, '--network', name, '--no-lb', '--no-image-volume', '--no-rollback',
    '--servers-memory', '768m', '--agents-memory', '768m',
    '--api-port', `127.0.0.1:${25013 + Number(stackId) * 100}`,
    '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false',
    '--runtime-label', `${label}=${record.id}@all`,
    '--k3s-node-label', `${label}=${record.id}@all`,
    '--k3s-arg', '--disable=traefik,servicelb@server:0', '--timeout', '120s',
    '--wait=false', ...volumes], 150_000);
  const created = await inspect(record);
  if (created.containers.length !== 3) throw new Error('Target creation is incomplete');
  record.containers = created.containers;
  await saveTarget(record);
  for (const container of record.containers) {
    await command('docker', ['update', '--cpus', '1', container]);
  }
  const config = await command('k3d', ['kubeconfig', 'get', name]);
  await writeFile(kubeconfig, config, { mode: 0o600 });
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      record.nodes = await readNodes(record);
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('Target nodes did not register in time');
      await delay(1000);
    }
  }
  await saveTarget(record);
  await command('kubectl', ['--kubeconfig', kubeconfig, '--context', context,
    'wait', '--for=condition=Ready', 'node', '--all', '--timeout=120s'], 130_000);
  record.nodes = await readNodes(record);
  await saveTarget(record);
}

export async function removeTarget() {
  if (!await targetRecorded()) return;
  const record = await readTarget();
  const found = await inspect(record);
  if (found.containers.length && Object.keys(record.nodes).length) await readNodes(record);
  record.containers = found.containers;
  await saveTarget(record);
  // Use immutable container and network IDs, including recovery of a labelled partial create.
  for (const container of found.containers) {
    await command('docker', ['rm', '-f', '-v', container]);
  }
  for (const network of found.networks) {
    await command('docker', ['network', 'rm', network]);
  }
  const remaining = await resources();
  if (remaining.containers.length || remaining.networks.length) {
    throw new Error('Target removal is incomplete');
  }
  await rm(storage, { recursive: true, force: true });
  await rm(kubeconfig, { force: true });
  await rm(recordFile);
}
