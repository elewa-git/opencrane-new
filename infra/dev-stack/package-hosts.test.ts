import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPackageHosts } from './package-hosts.ts';

const safe = { swaps: 'Filename Type Size Used Priority\n', corePattern: '\n',
  coreUsesPid: '0\n', crypttab: '', mappings: [] };
const unsafe = { ...safe, swaps: safe.swaps + '/swapfile file 10 0 -2\n',
  corePattern: '|apport\n' };
function fixture(states = [safe, safe]) {
  const calls: string[][] = [];
  let index = 0;
  async function command(args: string[]) {
    calls.push(args);
    if (args.includes('nodes')) {
      return JSON.stringify({ items: [
        { metadata: { name: 'node-1', uid: 'uid-1' } },
        { metadata: { name: 'node-2', uid: 'uid-2' } },
      ] });
    }
    if (args.includes('logs')) return JSON.stringify(states[index++]);
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
function nodeName(node: { name: string }) { return node.name; }
function isDelete(args: string[]) { return args.includes('delete'); }

test('refuse a failing second node before installation and clean its probe', async function refusal() {
  const { command, calls } = fixture([safe, unsafe]);
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc' });
  }
  await assert.rejects(check, /node-2.*F1:.*\n.*F2:/u);
  assert.equal(calls.filter(isDelete).length, 2);
});
test('a dev override cannot waive checks for a remote node', async function remoteOverride() {
  const { command } = fixture([unsafe, unsafe]);
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc',
      override: 'accepted-dev-box-366' });
  }
  await assert.rejects(check, /override requires verified local k3d nodes/u);
});
test('unknown override values fail closed', async function invalidOverride() {
  const { command } = fixture();
  async function check() {
    await checkPackageHosts({ command, namespace: 'test', image: 'image@sha256:abc', override: '1' });
  }
  await assert.rejects(check, /Unknown host-risk override/u);
});

test('local accepted exception is explicit and retained with both failures', async function localOverride(context) {
  const messages: string[] = [];
  function capture(message: string) { messages.push(message); }
  context.mock.method(console, 'warn', capture);
  const { command: probe, calls } = fixture([unsafe]);
  async function command(args: string[]) {
    if (args.includes('nodes')) return JSON.stringify({ items: [
      { metadata: { name: 'k3d-ocn-server-0', uid: 'local-node' } },
    ] });
    return probe(args);
  }
  async function localCommand(program: string, args: string[]) {
    if (program === 'node') return JSON.stringify(unsafe);
    if (args.includes('context')) return JSON.stringify('unix:///var/run/docker.sock');
    return JSON.stringify([{ Name: '/k3d-ocn-server-0', State: { Running: true },
      Config: { Labels: { 'k3d.cluster': 'ocn' } } }]);
  }
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
  await assert.rejects(check, /Installation nodes changed/u);
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
