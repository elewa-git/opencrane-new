import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requireAutomatedJourney } from '../../../infra/dev-stack/journey-guard.ts';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

const live = process.env['MCP_HOSTED_K3D'] === '1';
const specDigest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);
let namespace = '';
let otherNamespace = '';
let approved: unknown;
let secondImage = '';
const ownedNamespaces = new Map<string, string>();
type OwnedPolicy = { kind: string; name: string; namespace: string; owner: string; uid?: string };
const ownedPolicies: OwnedPolicy[] = [];
let metadataSource: Peer | undefined;

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
    throw new Error(`${binary} failed: status ${result.status}, signal ${result.signal}`);
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
  requireAutomatedJourney();
  const slot = process.env['DEV_STACK_ID'];
  expect(['1', '2']).toContain(slot);
  const owner = join(homedir(), '.config/opencrane', `dev-stack-${slot}`, 'stack-owner');
  expect(readFileSync(owner, 'utf8')).toContain(`worktree=${resolve('.')}\n`);
  approved = JSON.parse(readFileSync('apps/ops/mcp-hosted-template.json', 'utf8')) as unknown;
  namespace = `opencrane-dev-${slot}-${randomUUID().slice(0, 8)}-mcp`;
  otherNamespace = `opencrane-dev-${slot}-mcp-${randomUUID().slice(0, 8)}`;
  const computer: unknown = JSON.parse(readFileSync('apps/computer/sandbox-template.json', 'utf8'));
  const image = String(field(computer, 'spec.podTemplate.spec.containers.0.image'));
  secondImage = `example.invalid/unapproved@sha256:${otherDigest}`;
  expect(image).not.toBe(secondImage);
  change(approved, 'spec.replicas', 1);
  change(approved, 'spec.template.spec.containers.0.image', image);
  change(approved, 'metadata.annotations', { 'opencrane.ai/mcp-spec': specDigest });
  change(approved, 'spec.template.metadata.annotations', { 'opencrane.ai/mcp-spec': specDigest });
  createNamespace(namespace);
  createNamespace(otherNamespace);
  kube(['apply', '-f', 'infra/dev-stack/mcp-lifecycle-rbac.yaml']);
  kube(['apply', '-f', '-'], approvedImages(image));
  command('node', ['infra/dev-stack/mcp-resources.mjs', namespace]);
  const script = process.env['MCP_ADMISSION_SCRIPT'] ?? 'infra/dev-stack/mcp-admission.mjs';
  installPolicies(script, namespace);
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
function createNamespace(name: string) {
  const created: unknown = JSON.parse(kube(['create', 'namespace', name, '-o', 'json']));
  ownedNamespaces.set(name, String(field(created, 'metadata.uid')));
}
function installPolicies(script: string, target: string) {
  const rendered: unknown = JSON.parse(command('node', [script, target, '--render']));
  const items = field(rendered, 'items');
  if (!Array.isArray(items)) throw new Error('Missing admission policies');
  for (const object of items) createPolicy(object, target);
}
function createPolicy(object: unknown, target: string) {
  const record: OwnedPolicy = { kind: String(field(object, 'kind')).toLowerCase(),
    name: String(field(object, 'metadata.name')), namespace: target, owner: randomUUID() };
  change(object, 'metadata.labels', { 'opencrane.dev/fixture-owner': record.owner });
  // Remember the create before sending it so cleanup can recover a lost response.
  ownedPolicies.push(record);
  const created: unknown = JSON.parse(kube(['create', '-f', '-', '-o', 'json'], object));
  record.uid = String(field(created, 'metadata.uid'));
}
function checkedPolicies(records: OwnedPolicy[]) {
  for (const [name, uid] of ownedNamespaces) {
    const current = kube(['get', 'namespace', name, '--ignore-not-found',
      '-o', 'jsonpath={.metadata.uid}']);
    if (current && current !== uid) throw new Error('Fixture namespace ownership changed');
  }
  const present: OwnedPolicy[] = [];
  for (const record of records) {
    const output = kube(['get', record.kind, record.name, '--ignore-not-found', '-o', 'json']);
    if (!output) continue;
    const current: unknown = JSON.parse(output);
    const labels = field(current, 'metadata.labels');
    if (typeof labels !== 'object' || labels === null ||
        Reflect.get(labels, 'opencrane.dev/fixture-owner') !== record.owner) {
      throw new Error('Fixture policy ownership changed');
    }
    const uid = String(field(current, 'metadata.uid'));
    if (record.uid && uid !== record.uid) throw new Error('Fixture policy ownership changed');
    record.uid = uid;
    present.push(record);
  }
  return present;
}
function deletePolicies(records: OwnedPolicy[]) {
  // Check every identity before the first deletion, including a partially created policy.
  const present = checkedPolicies(records);
  for (const record of present) {
    kube(['delete', record.kind, record.name, '--ignore-not-found']);
  }
  for (const record of records) {
    const index = ownedPolicies.indexOf(record);
    if (index !== -1) ownedPolicies.splice(index, 1);
  }
}
function cleanup() {
  deletePolicies([...ownedPolicies]);
  if (ownedNamespaces.size) {
    kube(['delete', 'namespace', ...ownedNamespaces.keys(), '--wait=true', '--timeout=60s']);
  }
}
beforeAll(setup, 420_000);
afterAll(cleanup, 180_000);

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
  it('bounds each resource total without changing admission', quotaTotals, 90_000);
  it('allows only the gateway and reviewed upstream, with removal controls', network, 240_000);
  it('blocks metadata when a reachable control exists', metadataConnection, 60_000);
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
    ['get', 'secrets'], ['create', 'pods'], ['get', 'pods/proxy'], ['create', 'pods/proxy'],
  ];
  for (const resource of ['resourcequotas', 'networkpolicies', 'configmaps']) {
    for (const verb of ['create', 'update', 'delete']) forbidden.push([verb, resource]);
  }
  for (const [verb, resource] of forbidden) {
    function request() {
      const [kind, subresource] = resource!.split('/');
      const args = ['auth', 'can-i', verb!, kind!];
      if (subresource) args.push(`--subresource=${subresource}`);
      kube(args, undefined, true);
    }
    expect(request, `${verb} ${resource}`).toThrow('forbidden');
  }
  for (const resource of ['resourcequota/mcp-limit', 'networkpolicy/mcp-egress',
    'networkpolicy/mcp-ingress', 'configmap/mcp-approved-images']) {
    const patchBody = { metadata: { labels: { changed: 'yes' } } };
    function patch() {
      kube(['patch', resource, '--type=merge', '--dry-run=server',
        '-p', JSON.stringify(patchBody)], undefined, true);
    }
    expect(patch).toThrow('forbidden');
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
async function hostedResize() {
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
    kube(['delete', 'pod', 'mcp', '--wait=true', '--timeout=60s']);
    await waitForEmptyQuota();
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
    installPolicies(script, namespace);
    await delay(2000);
    kube(['create', '-f', '-'], candidate);
    function increaseCpu() {
      resizePod('computer', '2');
    }
    expect(increaseCpu).toThrow(/Computer must use the checked template/u);
  } finally {
    namespace = savedNamespace;
    function computerPolicy(record: OwnedPolicy) {
      return record.namespace === otherNamespace;
    }
    const records = ownedPolicies.filter(computerPolicy);
    deletePolicies(records);
    kube(['delete', '-n', otherNamespace, 'pod', 'computer',
      '--ignore-not-found', '--wait=true', '--timeout=60s']);
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
  const savedNamespace = namespace;
  try {
    createPolicy(policy, otherNamespace);
    createPolicy(binding, otherNamespace);
    await delay(2000);
    namespace = otherNamespace;
    admit(candidate, false);
    change(candidate, path, value);
    refuse(candidate, false);
  } finally {
    namespace = savedNamespace;
    function isolatedPolicy(record: OwnedPolicy) {
      return record.name === `${otherNamespace}-isolated`;
    }
    const records = ownedPolicies.filter(isolatedPolicy);
    deletePolicies(records);
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
async function waitForEmptyQuota() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const used = kube(['get', 'resourcequota/mcp-limit', '-o', 'jsonpath={.status.used.pods}']);
    if (used === '0') return;
    await delay(500);
  }
  throw new Error('Fixture quota usage did not settle');
}
async function quota() {
  await waitForEmptyQuota();
  const roomyTotals = { spec: { hard: { 'requests.cpu': '1', 'requests.memory': '2Gi',
    'limits.cpu': '8', 'limits.memory': '4Gi' } } };
  kube(['patch', 'resourcequota/mcp-limit', '--type=merge', '-p', JSON.stringify(roomyTotals)]);
  const names = ['quota-one', 'quota-two', 'quota-three', 'quota-four', 'quota-five'];
  try {
    const admittedNames = names.slice(0, 4);
    for (const name of admittedNames) {
      kube(['create', '-f', '-'], quotaPod(name));
    }
    function fifth() {
      kube(['create', '-f', '-'], quotaPod('quota-five'));
    }
    expect(fifth).toThrow('exceeded quota');
  } finally {
    kube(['delete', 'pods', ...names, '--ignore-not-found', '--wait=true', '--timeout=60s']);
    command('node', ['infra/dev-stack/mcp-resources.mjs', namespace]);
    await waitForEmptyQuota();
  }
}

async function quotaTotals() {
  await waitForEmptyQuota();
  const limits = [
    ['requests.cpu', '99m'], ['requests.memory', '255Mi'],
    ['limits.cpu', '999m'], ['limits.memory', '511Mi'],
  ];
  for (const [resource, value] of limits) {
    const patch = { spec: { hard: { [resource!]: value } } };
    kube(['patch', 'resourcequota/mcp-limit', '--type=merge', '-p', JSON.stringify(patch)]);
    try {
      function create() {
        kube(['create', '-f', '-'], quotaPod('total'));
      }
      expect(create).toThrow('exceeded quota');
    } finally {
      command('node', ['infra/dev-stack/mcp-resources.mjs', namespace]);
      kube(['delete', 'pod', 'total', '--ignore-not-found', '--wait=true', '--timeout=60s']);
    }
  }
  kube(['create', '-f', '-'], quotaPod('total'));
  kube(['delete', 'pod', 'total', '--wait=true', '--timeout=60s']);
}

type Peer = { namespace: string; name: string; address: string };
const listener = `
import http.server
import threading
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/health':
            self.send_error(404)
            return
        body = b'healthy'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        pass
for port in (8080, 8081):
    server = http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
`;
const probe = `
import socket
import sys
try:
    connection = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=1)
    connection.close()
    print('connected')
except OSError:
    print('blocked')
`;
function listenerPod(target: string, name: string, app: string): Peer {
  // Use an ordinary listener fixture; the computer entrypoint cannot run as a hosted tool.
  const spec = structuredClone(field(approved, pod));
  change(spec, 'containers.0.command', ['python3', '-c', listener]);
  const fixture = { apiVersion: 'v1', kind: 'Pod', metadata: { namespace: target, name,
    labels: { app } }, spec };
  kube(['create', '-n', target, '-f', '-'], fixture);
  return { namespace: target, name, address: '' };
}
async function ready(peer: Peer) {
  kube(['wait', '-n', peer.namespace, `pod/${peer.name}`, '--for=condition=Ready', '--timeout=60s']);
  peer.address = kube(['get', '-n', peer.namespace, `pod/${peer.name}`,
    '-o', 'jsonpath={.status.podIP}']);
  expect(peer.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  const local = [{ source: peer, address: '127.0.0.1', port: 8080, reason: peer.name }];
  await connections(local, 'connected');
}
function connect(source: Peer, address: string, port = 8080) {
  return kube(['exec', '-n', source.namespace, source.name, '--',
    'python3', '-c', probe, address, String(port)]);
}
type Connection = { source: Peer; address: string; port: number; reason: string };
async function connections(rows: Connection[], expected: string) {
  for (const row of rows) {
    let result = '';
    for (let attempt = 0; attempt < 15; attempt++) {
      result = connect(row.source, row.address, row.port);
      if (result === expected) break;
      await delay(500);
    }
    console.info(`${row.reason}: ${row.address}:${row.port} ${result} (expected ${expected})`);
    expect(result, row.reason).toBe(expected);
  }
}
async function removalControl(target: string, policy: string, rows: Connection[]) {
  await connections(rows, 'blocked');
  const saved: unknown = JSON.parse(kube(['get', '-n', target, 'networkpolicy', policy,
    '-o', 'json']));
  change(saved, 'metadata.resourceVersion', undefined);
  change(saved, 'metadata.uid', undefined);
  kube(['delete', '-n', target, 'networkpolicy', policy]);
  try {
    await connections(rows, 'connected');
  } finally {
    kube(['apply', '-n', target, '-f', '-'], saved);
  }
  await connections(rows, 'blocked');
}
async function network() {
  const target = `${namespace}-net-mcp`;
  const gatewayNamespace = `${namespace}-net-gateway`;
  const upstreamNamespace = `${namespace}-net`;
  for (const name of [target, gatewayNamespace, upstreamNamespace]) {
    createNamespace(name);
  }
  const hosted = listenerPod(target, 'mcp', 'mcp');
  metadataSource = hosted;
  const gateway = listenerPod(gatewayNamespace, 'gateway', 'opencrane-gateway');
  const wrongPod = listenerPod(gatewayNamespace, 'server', 'server');
  const foreign = listenerPod(otherNamespace, 'gateway', 'opencrane-gateway');
  const computer = listenerPod(upstreamNamespace, 'computer', 'computer');
  const upstream = listenerPod(upstreamNamespace, 'upstream', 'upstream');
  const arbitrary = listenerPod(upstreamNamespace, 'arbitrary', 'arbitrary');
  const unlabelled = listenerPod(target, 'unlabelled', '');
  for (const peer of [hosted, gateway, wrongPod, foreign, computer, upstream, arbitrary, unlabelled]) {
    await ready(peer);
  }
  const upstreamUid = kube(['get', '-n', upstreamNamespace, 'pod/upstream',
    '-o', 'jsonpath={.metadata.uid}']);
  kube(['label', '-n', upstreamNamespace, 'pod/upstream',
    `opencrane.ai/mcp-upstream=${upstreamUid}`]);
  command('node', ['infra/dev-stack/mcp-resources.mjs', target, '8080', 'pod:upstream:8080']);
  const ingress = [
    { source: wrongPod, address: unlabelled.address, port: 8080, reason: 'unlabelled target' },
    { source: wrongPod, address: hosted.address, port: 8080, reason: 'wrong Pod in right namespace' },
    { source: foreign, address: hosted.address, port: 8080, reason: 'right label in another silo' },
    { source: computer, address: hosted.address, port: 8080, reason: 'direct computer' },
    { source: upstream, address: hosted.address, port: 8080, reason: 'ordinary server' },
    { source: gateway, address: hosted.address, port: 8081, reason: 'undeclared MCP port' },
  ];
  const controlPlane = kube(['get', 'service', 'kubernetes', '-n', 'default',
    '-o', 'jsonpath={.spec.clusterIP}']);
  const nodeAddress = kube(['get', 'nodes', '-o',
    'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}']);
  const egress = [
    { source: hosted, address: nodeAddress, port: 6443, reason: 'node API server' },
    { source: hosted, address: nodeAddress, port: 10250, reason: 'node kubelet' },
    { source: unlabelled, address: upstream.address, port: 8081, reason: 'unlabelled source' },
    { source: hosted, address: controlPlane, port: 443, reason: 'control plane' },
    { source: hosted, address: upstream.address, port: 8081, reason: 'unreviewed upstream port' },
    { source: hosted, address: arbitrary.address, port: 8080, reason: 'arbitrary destination' },
    { source: hosted, address: foreign.address, port: 8080, reason: 'another silo' },
  ];
  expect(connect(gateway, hosted.address)).toBe('connected');
  expect(connect(hosted, upstream.address)).toBe('connected');
  const health = `import http.client
connection = http.client.HTTPConnection('${hosted.address}', 8080, timeout=2)
connection.request('GET', '/health')
response = connection.getresponse()
print(str(response.status) + ' ' + response.read().decode())`;
  expect(kube(['exec', '-n', gateway.namespace, gateway.name, '--',
    'python3', '-c', health])).toBe('200 healthy');
  await removalControl(target, 'mcp-ingress', ingress);
  await removalControl(target, 'mcp-egress', egress);
  expect(connect(gateway, hosted.address)).toBe('connected');
  expect(connect(hosted, upstream.address)).toBe('connected');
  command('node', ['infra/dev-stack/mcp-resources.mjs', target, '8080']);
  const withdrawn = [{ source: hosted, address: upstream.address, port: 8080,
    reason: 'withdrawn upstream binding' }];
  await connections(withdrawn, 'blocked');
  command('node', ['infra/dev-stack/mcp-resources.mjs', target, '8080', 'pod:upstream:8080']);
  await connections(withdrawn, 'connected');
  proxyRefusals(target);
}
function proxyRefusals(target: string) {
  kube(['apply', '-n', target, '-f', 'infra/dev-stack/mcp-lifecycle-rbac.yaml']);
  for (const port of [8080, 8081]) {
    const path = `/api/v1/namespaces/${target}/pods/mcp:${port}/proxy/health`;
    for (const verb of ['get', 'create']) {
      function proxy() {
        const args = [verb, '--raw', path, '--as',
          `system:serviceaccount:${target}:mcp-lifecycle`];
        if (verb === 'create') args.push('-f', '-');
        kube(args, {});
      }
      expect(proxy).toThrow('forbidden');
    }
  }
}

async function metadataConnection(context: TestContext) {
  if (!metadataSource) throw new Error('Network fixture was not started');
  const target = metadataSource.namespace;
  const saved: unknown = JSON.parse(kube(['get', '-n', target, 'networkpolicy/mcp-egress',
    '-o', 'json']));
  change(saved, 'metadata.resourceVersion', undefined);
  change(saved, 'metadata.uid', undefined);
  kube(['delete', '-n', target, 'networkpolicy/mcp-egress']);
  try {
    await delay(3000);
    const control = connect(metadataSource, '169.254.169.254', 80);
    if (control !== 'connected') context.skip('No reachable metadata listener without the policy');
  } finally {
    kube(['apply', '-n', target, '-f', '-'], saved);
  }
  const rows = [{ source: metadataSource, address: '169.254.169.254', port: 80,
    reason: 'metadata' }];
  await connections(rows, 'blocked');
}
