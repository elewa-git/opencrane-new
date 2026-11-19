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
