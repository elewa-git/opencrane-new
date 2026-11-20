import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPackageHosts } from './package-hosts.ts';
import type { HostState } from '../package/host-preflight.mjs';
import { packageCommandMessage } from './package-error.ts';

const safe = { swaps: 'Filename Type Size Used Priority\n', corePattern: '\n',
  coreUsesPid: '0\n', crypttab: '', mappings: [] };
const unsafe = { ...safe, swaps: safe.swaps + '/swapfile file 10 0 -2\n',
  corePattern: '|apport\n' };
function fixture(states: Record<string, HostState> = { 'node-1': safe, 'node-2': safe }) {
  const calls: string[][] = [];
  const podNodes = new Map<string, string>();
  async function command(args: string[]) {
    calls.push(args);
    if (args.includes('nodes')) {
      return JSON.stringify({ items: [
        { metadata: { name: 'node-1', uid: 'uid-1' } },
        { metadata: { name: 'node-2', uid: 'uid-2' } },
      ] });
    }
    if (args.includes('run')) {
      const pod = JSON.parse(args[args.indexOf('--overrides') + 1]!);
      const name = args[args.indexOf('run') + 1]!;
      podNodes.set(name, pod.spec.nodeName);
    }
    if (args.includes('logs')) {
      const name = args[args.indexOf('logs') + 1]!;
      const node = podNodes.get(name);
      assert.ok(node, 'Read observations only for a submitted probe Pod');
      const state = states[node];
      assert.ok(state, `No observations for submitted node ${node}`);
      return JSON.stringify(state);
    }
    return '';
  }
  return { command, calls };
}
test('check every target node, clean up probes and record each result', async function allNodes() {
  const { command, calls } = fixture();
  const record = await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  assert.deepEqual(record.nodes.map(nodeName), ['node-1', 'node-2']);
  assert.equal(record.override, undefined);
  const deletions = calls.filter(isDelete);
  assert.equal(deletions.length, 2);
});
function nodeName(node: { name: string }) {
  return node.name;
}
function isDelete(args: string[]) {
  return args.includes('delete');
}

test('refuse a failing second node before installation and clean its probe', async function refusal() {
  const { command, calls } = fixture({ 'node-1': safe, 'node-2': unsafe });
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  }
  await assert.rejects(check, { reason: 'unsafe_settings', message: /node-2.*F1:.*\n.*F2:/u });
  assert.equal(calls.filter(isDelete).length, 2);
});

test('package refusal shows F1 and F2 fixes without exposing unrelated errors',
  async function visibleHostRefusal() {
    const { command } = fixture({ 'node-1': unsafe, 'node-2': safe });
    let refusal: unknown;
    try {
      await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
    } catch (error) {
      refusal = error;
    }
    assert.equal((refusal as { reason: string }).reason, 'unsafe_settings');
    const message = packageCommandMessage(refusal);
    assert.match(message, /node-1: F1: disable swap/u);
    assert.match(message, /node-1: F2: disable host crash reporters/u);
    assert.equal(packageCommandMessage(new Error('F1: private dependency output')),
      'Package command refused; check pins, named secrets and slot ownership');
    assert.equal(packageCommandMessage(new Error('Required secret is absent: runtime')),
      'Required secret is absent: runtime');
  });
test('a dev override cannot waive checks for a remote node', async function remoteOverride() {
  const { command } = fixture({ 'node-1': unsafe, 'node-2': unsafe });
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc',
      override: 'accepted-dev-box-366' });
  }
  await assert.rejects(check, { reason: 'unverifiable_host',
    message: /override requires verified local k3d nodes/u });
});
test('unknown override values fail closed', async function invalidOverride() {
  const { command } = fixture();
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc', override: '1' });
  }
  await assert.rejects(check, { reason: 'unknown_override', message: /Unknown host-risk override/u });
});

type LocalFixtureOptions = {
  uid?: string;
  name?: string;
  endpoint?: string;
  count?: number;
  containerName?: string;
  running?: boolean;
  cluster?: string;
};
function localFixture(options: LocalFixtureOptions = {}) {
  const name = options.name ?? 'k3d-ocn-server-0';
  const states = { [name]: unsafe };
  const { command: probe, calls } = fixture(states);
  async function command(args: string[]) {
    if (args.includes('nodes')) return JSON.stringify({ items: [
      { metadata: { name, uid: 'local-node' } },
    ] });
    return probe(args);
  }
  async function localCommand(program: string, args: string[]) {
    if (program === 'node') return JSON.stringify(unsafe);
    if (args.includes('exec')) {
      assert.deepEqual(args.slice(2, 6), ['kubectl', 'get', 'node', name]);
      return options.uid ?? 'local-node';
    }
    if (args.includes('context')) {
      return JSON.stringify(options.endpoint ?? 'unix:///var/run/docker.sock');
    }
    const container = { Name: options.containerName ?? `/${name}`,
      State: { Running: options.running ?? true },
      Config: { Labels: { 'k3d.cluster': options.cluster ?? 'ocn' } } };
    const containers = Array(options.count ?? 1).fill(container);
    return JSON.stringify(containers);
  }
  return { command, localCommand, calls };
}

test('local accepted exception is explicit and retained with both failures', async function localOverride(context) {
  const messages: string[] = [];
  function capture(message: string) {
    messages.push(message);
  }
  context.mock.method(console, 'warn', capture);
  const { command, localCommand, calls } = localFixture();
  const record = await checkPackageHosts({ command, localCommand, namespace: 'test',
    image: 'image@sha256:abc', override: 'accepted-dev-box-366' });
  assert.equal(record.override, 'accepted-dev-box-366');
  assert.match(messages.join('\n'), /HOST RISK OVERRIDE: accepted-dev-box-366/u);
  assert.match(messages.join('\n'), /F1:/u);
  assert.match(messages.join('\n'), /F2:/u);
  assert.equal(record.nodes.length, 2);
  assert.equal(record.nodes[0]?.failures.length, 2);
  assert.equal(record.nodes[1]?.failures.length, 2);
  assert.equal(calls.filter(isDelete).length, 1);
});

test('an unreadable node refuses and removes its probe', async function unreadable() {
  const { command: probe, calls } = fixture();
  async function command(args: string[]) {
    if (args.includes('logs')) throw new Error('Host settings are unreadable');
    return probe(args);
  }
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  }
  await assert.rejects(check, /unreadable/u);
  assert.equal(calls.filter(isDelete).length, 1);
});

test('target changes during probes refuse installation', async function nodeDrift() {
  const { command: probe } = fixture();
  let listed = false;
  async function command(args: string[]) {
    if (args.includes('nodes')) {
      if (listed) return JSON.stringify({ items: [] });
      listed = true;
    }
    return probe(args);
  }
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  }
  await assert.rejects(check, { reason: 'unverifiable_host', message: /Installation nodes changed/u });
});

test('probe Pods have only read-only host mounts and no service token', async function readOnly() {
  const { command, calls } = fixture();
  await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  let probes = 0;
  for (const args of calls) {
    if (!args.includes('run')) continue;
    const pod = JSON.parse(args[args.indexOf('--overrides') + 1]!);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.restartPolicy, 'Never');
    assert.equal(pod.spec.volumes.length, 4);
    for (const container of pod.spec.containers) {
      assert.equal(container.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
      for (const mount of container.volumeMounts) assert.equal(mount.readOnly, true);
    }
    probes++;
  }
  assert.equal(probes, 2);
});


test('a matching local container name cannot waive another cluster node', async function falseLocalNode() {
  const { command, localCommand } = localFixture({ uid: 'foreign-node' });
  async function check() {
    await checkPackageHosts({ command, localCommand, namespace: 'test',
      image: 'image@sha256:abc', override: 'accepted-dev-box-366' });
  }
  await assert.rejects(check, { reason: 'unverifiable_host',
    message: /Local k3d node identity differs from the installation target/u });
});


const authorityRefusals: Array<{ name: string; options: LocalFixtureOptions; message: RegExp }> = [
  { name: 'Docker-context Unix endpoint', options: { endpoint: 'tcp://remote:2375' },
    message: /remote Docker endpoint/u },
  { name: 'permitted k3d name', options: { name: 'k3d-foreign-server-0', cluster: 'foreign' },
    message: /requires verified local k3d nodes/u },
  { name: 'container count', options: { count: 2 }, message: /Cannot verify/u },
  { name: 'exact container name', options: { containerName: '/another-container' },
    message: /Cannot verify/u },
  { name: 'Running container', options: { running: false }, message: /Cannot verify/u },
  { name: 'cluster label', options: { cluster: 'another-cluster' }, message: /Cannot verify/u },
];
for (const refusal of authorityRefusals) {
  test(`override authority requires ${refusal.name}`, async function authorityGuard() {
    const { command, localCommand } = localFixture(refusal.options);
    async function check() {
      await checkPackageHosts({ command, localCommand, namespace: 'test',
        image: 'image@sha256:abc', override: 'accepted-dev-box-366' });
    }
    await assert.rejects(check, { reason: 'unverifiable_host', message: refusal.message });
  });
}

test('override authority requires DOCKER_HOST Unix endpoint', async function dockerHost(context) {
  const original = process.env['DOCKER_HOST'];
  function restoreHost() {
    if (original === undefined) delete process.env['DOCKER_HOST'];
    else process.env['DOCKER_HOST'] = original;
  }
  context.after(restoreHost);
  process.env['DOCKER_HOST'] = 'tcp://remote:2375';
  const { command, localCommand } = localFixture();
  async function check() {
    await checkPackageHosts({ command, localCommand, namespace: 'test',
      image: 'image@sha256:abc', override: 'accepted-dev-box-366' });
  }
  await assert.rejects(check, { reason: 'unverifiable_host', message: /remote Docker endpoint/u });
});
