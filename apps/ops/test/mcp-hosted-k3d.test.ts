import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const live = process.env['MCP_HOSTED_K3D'] === '1';
const specDigest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
let namespace = '';
let otherNamespace = '';
let directory = '';
let approved: unknown;
let secondImage = '';

function command(binary: string, args: string[], input?: string): string {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0) {
    if (args.includes('can-i') && result.stdout.trim() === 'no') throw new Error('forbidden');
    for (const reason of ['denied', 'forbidden', 'is invalid:']) {
      if (result.stderr?.includes(reason)) throw new Error(reason);
    }
    throw new Error(`${binary} failed (private output withheld)`);
  }
  return result.stdout.trim();
}
function kube(args: string[], input?: unknown, lifecycle = false) {
  const prefix = ['--context=k3d-ocn', '-n', namespace];
  if (lifecycle) prefix.push('--as', `system:serviceaccount:${namespace}:mcp-lifecycle`);
  return command('kubectl', [...prefix, ...args], JSON.stringify(input));
}
function field(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) throw new Error(`Missing ${path}`);
    current = Reflect.get(current, key);
  }
  return current;
}
function change(value: unknown, path: string, replacement: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = field(value, keys.join('.'));
  if (typeof parent !== 'object' || parent === null) throw new Error(`Missing ${path}`);
  if (replacement === undefined) Reflect.deleteProperty(parent, last);
  else Reflect.set(parent, last, replacement);
}
function workload() {
  return structuredClone(approved);
}
function admit(value: unknown, lifecycle = true) {
  return kube(['create', '--dry-run=server', '-f', '-'], value, lifecycle);
}
function refuse(value: unknown, lifecycle = true, builtIn = false) {
  function request() {
    admit(value, lifecycle);
  }
  expect(request).toThrow(builtIn ? /denied|is invalid:/u : /denied/u);
}
function buildImage(label: string) {
  const computer: unknown = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  const base = String(field(computer, 'spec.podTemplate.spec.containers.0.image'));
  const address = command('docker', ['inspect', 'k3d-ocn-registry', '--format',
    '{{(index .NetworkSettings.Networks "k3d-ocn").IPAddress}}']);
  expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  const tag = `${address}:5000/opencrane/computer:${namespace}-${label}`;
  const metadata = join(directory, 'build.json');
  const dockerfile = `FROM ${base.replace('k3d-ocn-registry:5000', '127.0.0.1:5001')}\n`
    + `LABEL test.mcp=${namespace}-${label}\n`;
  writeFileSync(join(directory, 'Dockerfile'), dockerfile);
  command('nice', ['-n', '10', 'docker', 'buildx', 'build', '--network=none',
    '--output', `type=image,name=${tag},push=true,registry.insecure=true`,
    '--metadata-file', metadata, directory]);
  const result: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
  const digest: unknown = Reflect.get(Object(result), 'containerimage.digest');
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return `k3d-ocn-registry:5000/opencrane/computer@${String(digest)}`;
}
function approvedImages(image: string) {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'mcp-approved-images' },
    data: { [specDigest]: image, [otherDigest]: secondImage } };
}
async function setup() {
  if (!live) return;
  const slot = process.env['DEV_STACK_ID'];
  expect(['1', '2']).toContain(slot);
  const owner = join(homedir(), '.config/opencrane', `dev-stack-${slot}`, 'stack-owner');
  expect(readFileSync(owner, 'utf8')).toContain(`worktree=${resolve('.')}\n`);
  approved = JSON.parse(readFileSync('apps/ops/mcp-hosted-template.json', 'utf8')) as unknown;
  namespace = `opencrane-dev-${slot}-mcp-${randomUUID().slice(0, 8)}`;
  otherNamespace = `opencrane-dev-${slot}-mcp-${randomUUID().slice(0, 8)}`;
  directory = mkdtempSync(join(tmpdir(), 'mcp-hosted-'));
  const image = String(buildImage('first'));
  secondImage = String(buildImage('second'));
  expect(image).not.toBe(secondImage);
  change(approved, 'spec.replicas', 1);
  change(approved, 'spec.template.spec.containers.0.image', image);
  change(approved, 'metadata.annotations', { 'opencrane.ai/mcp-spec': specDigest });
  change(approved, 'spec.template.metadata.annotations', { 'opencrane.ai/mcp-spec': specDigest });
  kube(['create', 'namespace', namespace]);
  kube(['create', 'namespace', otherNamespace]);
  kube(['apply', '-f', 'infra/dev-stack/mcp-lifecycle-rbac.yaml']);
  kube(['apply', '-f', '-'], approvedImages(image));
  const script = process.env['MCP_ADMISSION_SCRIPT'] ?? 'infra/dev-stack/mcp-admission.mjs';
  command('node', [script, namespace]);
  const invalidReplicas = workload();
  change(invalidReplicas, 'spec.replicas', 2);
  // Wait for policy distribution before testing the individual refusals.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      admit(invalidReplicas);
    } catch (error) {
      if (error instanceof Error && error.message === 'denied') return;
      throw error;
    }
    await delay(500);
  }
  throw new Error('Admission policy did not become active');
}
function cleanup() {
  if (namespace) {
    for (const suffix of ['statefulset', 'pod', 'scale']) {
      kube(['delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding',
        `${namespace}-${suffix}`, '--ignore-not-found']);
    }
    kube(['delete', 'namespace', namespace, otherNamespace, '--ignore-not-found', '--wait=false']);
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
}
beforeAll(setup, 420_000);
afterAll(cleanup);

const pod = 'spec.template.spec';
const container = `${pod}.containers.0`;
const security = `${container}.securityContext`;
const guards: [string, string, unknown][] = [
  ['gVisor', `${pod}.runtimeClassName`, undefined],
  ['root user', `${security}.runAsUser`, 0],
  ['writable root', `${security}.readOnlyRootFilesystem`, false],
  ['privilege escalation', `${security}.allowPrivilegeEscalation`, true],
  ['privileged', `${security}.privileged`, true],
  ['capability', `${security}.capabilities.add`, ['NET_ADMIN']],
  ['seccomp', `${security}.seccompProfile.type`, 'Unconfined'],
  ['host network', `${pod}.hostNetwork`, true],
  ['host PID', `${pod}.hostPID`, true],
  ['host IPC', `${pod}.hostIPC`, true],
  ['host path', `${pod}.volumes`, [{ name: 'scratch', hostPath: { path: '/tmp' } }]],
  ['devices', `${container}.volumeDevices`, [{ name: 'scratch', devicePath: '/dev/test' }]],
  ['token', `${pod}.automountServiceAccountToken`, true],
  ['init container', `${pod}.initContainers`, [{ name: 'init', image: 'test' }]],
  ['PVC', 'spec.volumeClaimTemplates', [{ metadata: { name: 'data' },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }]],
  ['env', `${container}.env`, [{ name: 'EXTRA', value: 'test' }]],
  ['envFrom', `${container}.envFrom`, [{ configMapRef: { name: 'extra' } }]],
  ['command', `${container}.command`, ['/bin/true']],
  ['args', `${container}.args`, ['extra']],
  ['disk scratch', `${pod}.volumes.0.emptyDir.medium`, ''],
  ['large scratch', `${pod}.volumes.0.emptyDir.sizeLimit`, '65Mi'],
  ['raised limits', `${container}.resources.limits.cpu`, '2'],
  ['missing limits', `${container}.resources.limits`, undefined],
];
describe.skipIf(!live)('hosted MCP namespace', cases);
function cases() {
  it.each(guards)('denies %s', guard);
  it('denies another container', extraContainer);
  it('binds image and spec digest to protected parameters', images);
  it('denies the admin creating an approved workload', requester);
  it('fails closed without parameters', parameters);
  it('limits lifecycle permissions to this namespace', permissions);
  it('creates a Pod, allows only scaling and completes deletion', lifecycle, 90_000);
}
function guard(name: string, path: string, value: unknown) {
  const candidate = workload();
  change(candidate, path, value);
  refuse(candidate, true, name === 'privileged' || name === 'devices');
}
function extraContainer() {
  const candidate = workload();
  const extra = { name: 'extra', image: secondImage };
  const containers = [field(candidate, `${pod}.containers.0`), extra];
  change(candidate, `${pod}.containers`, containers);
  refuse(candidate);
}
function images() {
  for (const image of [secondImage, 'example:latest']) {
    const candidate = workload();
    change(candidate, `${container}.image`, image);
    refuse(candidate);
  }
  const candidate = workload();
  change(candidate, 'spec.template.metadata.annotations', { 'opencrane.ai/mcp-spec': otherDigest });
  change(candidate, 'metadata.annotations', { 'opencrane.ai/mcp-spec': otherDigest });
  refuse(candidate);
}
function requester() {
  refuse(workload(), false);
}
function parameters() {
  kube(['delete', 'configmap', 'mcp-approved-images']);
  try {
    refuse(workload());
  } finally {
    kube(['apply', '-f', '-'], approvedImages(String(field(approved, `${container}.image`))));
  }
}
function permissions() {
  const forbidden = [
    ['patch', 'configmaps'], ['patch', 'validatingadmissionpolicies'], ['patch', 'roles'],
    ['patch', 'resourcequotas'], ['patch', 'networkpolicies'], ['create', 'pods/exec'],
    ['get', 'secrets'], ['create', 'pods'],
  ];
  for (const [verb, resource] of forbidden) {
    function request() {
      kube(['auth', 'can-i', verb!, resource!], undefined, true);
    }
    expect(request).toThrow('forbidden');
  }
  for (const target of [otherNamespace, `opencrane-dev-${process.env['DEV_STACK_ID']}`]) {
    function request() {
      kube(['delete', 'pod', 'absent', '-n', target, '--dry-run=server'], undefined, true);
    }
    expect(request).toThrow('forbidden');
  }
}
async function lifecycle() {
  const candidate = workload();
  admit(candidate);
  kube(['create', '-f', '-'], candidate, true);
  const name = String(field(candidate, 'metadata.name'));
  await waitForPod(name, true);
  const changedImage = workload();
  change(changedImage, `${container}.image`, secondImage);
  change(changedImage, 'spec.template.metadata.annotations', { 'opencrane.ai/mcp-spec': otherDigest });
  change(changedImage, 'metadata.annotations', { 'opencrane.ai/mcp-spec': otherDigest });
  for (const patch of [
    changedImage,
    { spec: { template: { metadata: { labels: { changed: 'yes' } } } } },
    { spec: { replicas: 2 } },
  ]) {
    function update() {
      kube(['patch', `statefulset/${name}`, '--type=merge', '--dry-run=server',
        '-p', JSON.stringify(patch)], undefined, true);
    }
    expect(update).toThrow('denied');
  }
  function tooManyReplicas() {
    kube(['scale', `statefulset/${name}`, '--replicas=2', '--dry-run=server'], undefined, true);
  }
  expect(tooManyReplicas).toThrow('denied');
  function adminScale() {
    kube(['scale', `statefulset/${name}`, '--replicas=0', '--dry-run=server']);
  }
  expect(adminScale).toThrow('denied');
  const bare = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'bare',
    annotations: { 'opencrane.ai/mcp-spec': specDigest } },
  spec: structuredClone(field(candidate, pod)) };
  change(bare, 'spec.runtimeClassName', undefined);
  refuse(bare, false);
  function ephemeral() {
    const patch = { spec: { ephemeralContainers: [{ name: 'debug', image: secondImage,
      targetContainerName: 'mcp' }] } };
    kube(['patch', `pod/${name}-0`, '--subresource=ephemeralcontainers', '--type=merge',
      '--dry-run=server', '-p', JSON.stringify(patch)]);
  }
  expect(ephemeral).toThrow('denied');
  kube(['scale', `statefulset/${name}`, '--replicas=0'], undefined, true);
  await waitForPod(name, false);
  kube(['delete', `statefulset/${name}`, '--cascade=foreground', '--wait=true',
    '--timeout=30s'], undefined, true);
}
async function waitForPod(name: string, present: boolean) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const uid = kube(['get', `pod/${name}-0`, '--ignore-not-found', '-o', 'jsonpath={.metadata.uid}']);
    if (Boolean(uid) === present) return;
    await delay(500);
  }
  throw new Error('Fixture Pod timeout');
}
