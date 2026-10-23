import { execFileSync } from 'node:child_process';
import { mcpNamespace } from './mcp-namespace.mjs';

const namespace = mcpNamespace(process.argv[2]);
function portNumber(value) {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Expected a TCP port');
  }
  return port;
}
function upstreamRule(binding) {
  const [kind, name, port, extra] = binding.split(':');
  if (kind !== 'pod' || !name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) ||
      name.length > 63 || extra !== undefined) {
    throw new Error('Expected an approved in-silo Pod binding: pod:name:port');
  }
  const upstreamNamespace = namespace.slice(0, -4);
  const upstreamPort = portNumber(port);
  let upstream;
  try {
    const output = execFileSync('kubectl', ['--context=k3d-ocn', '-n', upstreamNamespace,
      'get', 'pod', name, '-o', 'json'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    upstream = JSON.parse(output);
  } catch {
    throw new Error('Could not check hosted MCP upstream ownership');
  }
  const metadata = upstream.metadata;
  const uid = metadata?.uid;
  // Bind approval to this Pod's UID so a replacement or reused IP inherits no permission.
  if (!uid || metadata.name !== name || metadata.namespace !== upstreamNamespace ||
      metadata.labels?.['opencrane.ai/mcp-upstream'] !== uid ||
      metadata.deletionTimestamp || !upstream.spec || upstream.spec.hostNetwork === true) {
    throw new Error('Expected an approved in-silo Pod');
  }
  const peer = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': upstreamNamespace } },
    podSelector: { matchLabels: { 'opencrane.ai/mcp-upstream': uid } },
  };
  return { to: [peer], ports: [{ protocol: 'TCP', port: upstreamPort }] };
}
const ingress = [];
if (process.argv[3] !== undefined) {
  const gatewayNamespace = `${namespace.slice(0, -4)}-gateway`;
  // Keep both selectors in one peer: the namespace and Pod label must both match.
  const gateway = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': gatewayNamespace } },
    podSelector: { matchLabels: { app: 'opencrane-gateway' } },
  };
  const rule = { from: [gateway],
    ports: [{ protocol: 'TCP', port: portNumber(process.argv[3]) }] };
  ingress.push(rule);
}
const bindings = process.argv.slice(4);
const egress = bindings.map(upstreamRule);
const quota = { apiVersion: 'v1', kind: 'ResourceQuota',
  metadata: { name: 'mcp-limit', namespace },
  spec: { hard: { pods: '4', 'requests.cpu': '400m', 'requests.memory': '1Gi',
    'limits.cpu': '4', 'limits.memory': '2Gi' } } };
const ingressPolicy = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name: 'mcp-ingress', namespace },
  spec: { podSelector: {}, policyTypes: ['Ingress'], ingress } };
const egressPolicy = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name: 'mcp-egress', namespace },
  spec: { podSelector: {}, policyTypes: ['Egress'], egress } };
const resources = { apiVersion: 'v1', kind: 'List',
  items: [ingressPolicy, egressPolicy, quota] };
try {
  execFileSync('kubectl', ['--context=k3d-ocn', 'apply', '-f', '-'],
    { input: JSON.stringify(resources), stdio: ['pipe', 'pipe', 'pipe'] });
} catch {
  throw new Error('Could not install hosted MCP namespace resources');
}
