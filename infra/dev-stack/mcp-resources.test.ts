import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const namespace = 'fixture-mcp';
const upstreamUid = '11111111-1111-4111-8111-111111111111';

function generate(args: string[], podChanges = {}, fail = false) {
  const applied: any[] = [];
  const upstream = { metadata: { name: 'upstream', namespace: 'fixture', uid: upstreamUid,
    labels: { 'opencrane.ai/mcp-upstream': upstreamUid } }, spec: { hostNetwork: false },
    ...podChanges };
  function execFileSync(_binary: string, command: string[], options: any) {
    if (fail) throw new Error('private-kubernetes-output');
    if (command.includes('get')) return JSON.stringify(upstream);
    applied.push(JSON.parse(options.input));
    return '';
  }
  const path = new URL('./mcp-resources.mjs', import.meta.url);
  let source = readFileSync(path, 'utf8');
  source = source.replace(/^import .*;\n/gmu, '');
  // Run the real CLI with only its process and Kubernetes boundaries replaced.
  const context = { process: { argv: ['node', 'script', ...args] }, execFileSync,
    require, isIPv4: require('node:net').isIPv4,
    mcpNamespace: validateNamespace, upstreamUid };
  function validateNamespace(value: string) {
    const validator = readFileSync(new URL('./mcp-namespace.mjs', import.meta.url), 'utf8');
    const callable = validator.replace('export ', '');
    return runInNewContext(`${callable}\nmcpNamespace(value)`, { value });
  }
  runInNewContext(source, context);
  return JSON.parse(JSON.stringify(applied.at(-1)));
}

const unsafe = ['10.43.0.1:443', '10.42.0.9:8080', '192.168.1.2:6443',
  '172.18.0.2:10250', '100.64.0.1:443', '8.8.8.8:443', '127.0.0.1:80',
  '169.254.169.254:80', '0.0.0.0:80', '224.0.0.1:80', 'example.com:80',
  '10.0.0.0/8:80', '[::1]:80'];
for (const binding of unsafe) {
  test(`refuses raw or unresolved destination ${binding}`, function refuse() {
    assert.throws(function install() { generate([namespace, '8080', binding]); });
  });
}
for (const value of ['', '-mcp', '-bad-mcp', 'bad--mcp-', 'BAD-mcp', 'a'.repeat(64) + '-mcp']) {
  test(`refuses invalid namespace ${value}`, function refuse() {
    assert.throws(function install() { generate([value]); });
  });
}
for (const port of ['0', '65536', '-1', '1.5', '80x', '']) {
  test(`refuses invalid port ${port}`, function refuse() {
    assert.throws(function install() { generate([namespace, port]); });
  });
}
test('empty configuration denies both directions for every Pod and bounds resources', function empty() {
  const result = generate([namespace]);
  assert.deepEqual(result.items[0].spec, {
    podSelector: {}, policyTypes: ['Ingress'], ingress: [],
  });
  assert.deepEqual(result.items[1].spec, {
    podSelector: {}, policyTypes: ['Egress'], egress: [],
  });
  assert.deepEqual(result.items[2].spec.hard, { pods: '4', 'requests.cpu': '400m',
    'requests.memory': '1Gi', 'limits.cpu': '4', 'limits.memory': '2Gi' });
});
test('allows only the named gateway and the approved Pod identity over TCP', function ownedPod() {
  const result = generate([namespace, '8080', 'pod:upstream:443']);
  assert.deepEqual(result.items[0].spec.ingress, [{ from: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture-gateway' } },
    podSelector: { matchLabels: { app: 'opencrane-gateway' } },
  }], ports: [{ protocol: 'TCP', port: 8080 }] }]);
  assert.deepEqual(result.items[1].spec.egress, [{ to: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture' } },
    podSelector: { matchLabels: { 'opencrane.ai/mcp-upstream': upstreamUid } },
  }], ports: [{ protocol: 'TCP', port: 443 }] }]);
  // Require replacement arrays, including empty arrays, on the same managed objects.
  const shrunk = generate([namespace, '8080']);
  assert.deepEqual(shrunk.items[1].metadata, result.items[1].metadata);
  assert.deepEqual(shrunk.items[1].spec.egress, []);
});
const unowned = [
  { metadata: { name: 'upstream', namespace: 'foreign', uid: upstreamUid,
    labels: { 'opencrane.ai/mcp-upstream': upstreamUid } } },
  { metadata: { name: 'upstream', namespace: 'fixture', uid: upstreamUid, labels: {} } },
  { metadata: { name: 'upstream', namespace: 'fixture', uid: 'replacement',
    labels: { 'opencrane.ai/mcp-upstream': upstreamUid } } },
  { spec: { hostNetwork: true } },
];
for (const changes of unowned) {
  test(`refuses unowned or host-network Pod ${JSON.stringify(changes)}`, function refusal() {
    assert.throws(function install() { generate([namespace, '8080', 'pod:upstream:443'], changes); });
  });
}
test('never prints Kubernetes failure output', function privateOutput() {
  assert.throws(function install() { generate([namespace], {}, true); }, function safe(error: Error) {
    assert.doesNotMatch(error.message, /private-kubernetes-output/u);
    return true;
  });
});
test('lifecycle has no Pod proxy rights', function noProxy() {
  const role = readFileSync(new URL('./mcp-lifecycle-rbac.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(role, /pods\/proxy/u);
});
