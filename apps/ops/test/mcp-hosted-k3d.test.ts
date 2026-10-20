import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const live = process.env['MCP_HOSTED_K3D'] === '1';
const specDigest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
let namespace = '';
let otherNamespace = '';
let approved: unknown;
let secondImage = '';

function command(binary: string, args: string[], input?: string): string {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0) {
    if (args.includes('can-i') && result.stdout.trim() === 'no') throw new Error('forbidden');
    const refusal = /Hosted MCP check \d+ requires the approved template or identity/u;
    const policyMessage = result.stderr?.match(refusal);
    if (result.stderr?.includes('Computer must use the checked template')) {
      throw new Error('denied: Computer must use the checked template');
    }
    if (policyMessage) throw new Error(`denied: ${policyMessage[0]}`);
    for (const reason of ['exceeded quota', 'denied', 'forbidden', 'is invalid:']) {
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
  const parent = keys.length === 0 ? value : field(value, keys.join('.'));
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
function refuse(value: unknown, lifecycle = true, message = /Hosted MCP check/u) {
  function request() {
    admit(value, lifecycle);
  }
  expect(request).toThrow(message);
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
  const computer: unknown = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  const image = String(field(computer, 'spec.podTemplate.spec.containers.0.image'));
  secondImage = `example.invalid/unapproved@sha256:${otherDigest}`;
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
      if (error instanceof Error && error.message.startsWith('denied')) return;
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
  ['capability', `${security}.capabilities.add`, ['NET_ADMIN']],
  ['seccomp', `${security}.seccompProfile.type`, 'Unconfined'],
  ['host network', `${pod}.hostNetwork`, true],
  ['host PID', `${pod}.hostPID`, true],
  ['host IPC', `${pod}.hostIPC`, true],
  ['host path', `${pod}.volumes`, [{ name: 'scratch', hostPath: { path: '/tmp' } }]],
  ['token', `${pod}.automountServiceAccountToken`, true],
  ['init container', `${pod}.initContainers`, [{ name: 'init', image: 'test' }]],
  ['PVC', 'spec.volumeClaimTemplates', [{ metadata: { name: 'data' },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } }]],
  ['Secret-sourced env', `${container}.env`, [{ name: 'EXTRA',
    valueFrom: { secretKeyRef: { name: 'secret', key: 'value' } } }]],
  ['hostPort', `${container}.ports`, [{ containerPort: 8080, hostPort: 8080 }]],
  ['envFrom', `${container}.envFrom`, [{ configMapRef: { name: 'extra' } }]],
  ['command', `${container}.command`, ['/bin/true']],
  ['args', `${container}.args`, ['extra']],
  ['disk scratch', `${pod}.volumes.0.emptyDir.medium`, ''],
  ['large scratch', `${pod}.volumes.0.emptyDir.sizeLimit`, '65Mi'],
  ['raised limits', `${container}.resources.limits.cpu`, '2'],
];
describe.skipIf(!live)('hosted MCP namespace', cases);
function cases() {
  it.each(guards)('denies %s', guard);
  it('denies devices', devices);
  it('denies privileged', privileged);
  it('denies missing limits', missingLimits);
  it('denies another container', extraContainer);
  it('denies an approved image tag', imageTag);
  it('denies hosted Pod resize', hostedResize);
  it('denies computer Pod resize', computerResize);
  it('binds image and spec digest to protected parameters', images);
  it('denies the admin creating an approved workload', requester);
  it('fails closed without parameters', parameters);
  it('limits lifecycle permissions to this namespace', permissions);
  it('creates a Pod, allows only scaling and completes deletion', lifecycle, 90_000);
  it('admits four Pods and refuses a fifth through quota', quota, 90_000);
}
function guard(_name: string, path: string, value: unknown) {
  const candidate = workload();
  change(candidate, path, value);
  refuse(candidate);
}
function extraContainer() {
  const candidate = workload();
  const extra = { name: 'extra', image: secondImage };
  const containers = [field(candidate, `${pod}.containers.0`), extra];
  change(candidate, `${pod}.containers`, containers);
  refuse(candidate);
}
function images() {
  for (const image of [secondImage]) {
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
    refuse(workload(), true, /denied/u);
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

async function imageTag() {
  const image = 'example:latest';
  kube(['apply', '-f', '-'], approvedImages(image));
  await delay(2000);
  try {
    const candidate = workload();
    change(candidate, `${container}.image`, image);
    change(candidate, `${container}.imagePullPolicy`, 'IfNotPresent');
    refuse(candidate);
  } finally {
    kube(['apply', '-f', '-'], approvedImages(String(field(approved, `${container}.image`))));
  }
}
function resizePod(name: string, cpu: string) {
  const patch = { spec: { containers: [{ name, resources: { limits: { cpu } } }] } };
  return kube(['patch', `pod/${name}`, '--subresource=resize', '--type=strategic',
    '--dry-run=server', '-p', JSON.stringify(patch)]);
}
function hostedResize() {
  const candidate = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mcp',
    annotations: { 'opencrane.ai/mcp-spec': specDigest } },
  spec: structuredClone(field(approved, pod)) };
  kube(['create', '-f', '-'], candidate);
  try {
    resizePod('mcp', '1');
    function increaseCpu() {
      resizePod('mcp', '2');
    }
    expect(increaseCpu).toThrow(/Hosted MCP check/u);
  } finally {
    kube(['delete', 'pod', 'mcp', '--wait=false']);
  }
}
async function computerResize() {
  const template: unknown = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  const candidate = { apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'computer', labels: { app: 'computer' } },
    spec: field(template, 'spec.podTemplate.spec') };
  const savedNamespace = namespace;
  namespace = otherNamespace;
  try {
    const script = process.env['COMPUTER_ADMISSION_SCRIPT']
      ?? 'infra/dev-stack/computer-admission.mjs';
    command('node', [script, namespace]);
    await delay(2000);
    kube(['create', '-f', '-'], candidate);
    function increaseCpu() {
      resizePod('computer', '2');
    }
    expect(increaseCpu).toThrow(/Computer must use the checked template/u);
  } finally {
    for (const suffix of ['sandbox', 'pod', 'claim']) {
      kube(['delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding',
        `${namespace}-computer-${suffix}`, '--ignore-not-found']);
    }
    kube(['delete', 'pod', 'computer', '--ignore-not-found', '--wait=false']);
    namespace = savedNamespace;
  }
}

async function isolatedGuard(
  candidate: unknown, expressionField: string, path: string, value: unknown,
) {
  // Isolate one check so other template rules cannot hide a missing guard.
  const policy: unknown = JSON.parse(kube(['get', 'validatingadmissionpolicy',
    `${namespace}-statefulset`, '-o', 'json']));
  const validations = field(policy, 'spec.validations');
  if (!Array.isArray(validations)) throw new Error('Missing policy validations');
  function checksContainer(value: unknown) {
    return String(field(value, 'expression')).includes(expressionField);
  }
  const selectedChecks = validations.filter(checksContainer);
  expect(selectedChecks).toHaveLength(1);
  change(policy, 'metadata', { name: `${otherNamespace}-isolated` });
  change(policy, 'spec.validations', selectedChecks);
  const binding = { apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding', metadata: { name: `${otherNamespace}-isolated` },
    spec: { policyName: `${otherNamespace}-isolated`, validationActions: ['Deny'],
      paramRef: { name: 'mcp-approved-images', namespace, parameterNotFoundAction: 'Deny' },
      matchResources: { namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': otherNamespace } } } } };
  kube(['apply', '-f', '-'], policy);
  kube(['apply', '-f', '-'], binding);
  await delay(2000);
  const savedNamespace = namespace;
  namespace = otherNamespace;
  try {
    admit(candidate, false);
    change(candidate, path, value);
    refuse(candidate, false);
  } finally {
    kube(['delete', 'validatingadmissionpolicy,validatingadmissionpolicybinding',
      `${namespace}-isolated`, '--ignore-not-found']);
    namespace = savedNamespace;
  }
}

async function devices() {
  const candidate = workload();
  const volumes = [field(candidate, `${pod}.volumes.0`),
    { name: 'block', persistentVolumeClaim: { claimName: 'block' } }];
  change(candidate, `${pod}.volumes`, volumes);
  const devices = [{ name: 'block', devicePath: '/dev/test' }];
  await isolatedGuard(candidate, '!has(variables.container.command)',
    `${container}.volumeDevices`, devices);
}
async function privileged() {
  const candidate = workload();
  // Allow Kubernetes to validate this privileged fixture before the isolated policy checks it.
  change(candidate, `${security}.allowPrivilegeEscalation`, true);
  change(candidate, `${security}.seccompProfile`, undefined);
  await isolatedGuard(candidate, '!has(variables.container.securityContext.procMount)',
    `${security}.privileged`, true);
}

async function missingLimits() {
  await isolatedGuard(workload(), 'has(variables.pod.containers)',
    `${container}.resources.limits`, undefined);
}

function quotaPod(name: string) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name,
    annotations: { 'opencrane.ai/mcp-spec': specDigest } },
  spec: structuredClone(field(approved, pod)) };
}
function quota() {
  const names = ['quota-one', 'quota-two', 'quota-three', 'quota-four', 'quota-five'];
  try {
    for (const name of names.slice(0, 4)) kube(['create', '-f', '-'], quotaPod(name));
    function fifth() {
      kube(['create', '-f', '-'], quotaPod('quota-five'));
    }
    expect(fifth).toThrow('exceeded quota');
  } finally {
    kube(['delete', 'pods', ...names, '--ignore-not-found', '--wait=true', '--timeout=60s']);
  }
}
