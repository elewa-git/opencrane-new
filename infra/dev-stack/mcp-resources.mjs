import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';

const namespace = process.argv[2];
if (!namespace || !/^[a-z0-9-]+$/.test(namespace) || !namespace.endsWith('-mcp')) {
  throw new Error('Expected MCP namespace');
}
function portNumber(value) {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Expected a TCP port');
  }
  return port;
}
function upstreamRule(binding) {
  const [address, port, extra] = binding.split(':');
  // Require one reviewed IPv4 address, never a hostname, subnet or link-local service.
  const first = Number(address.split('.')[0]);
  if (!isIPv4(address) || extra !== undefined || first === 0 || first === 127 ||
      first >= 224 || address.startsWith('169.254.')) {
    throw new Error('Expected a reviewed upstream IPv4 address');
  }
  return { to: [{ ipBlock: { cidr: `${address}/32` } }],
    ports: [{ protocol: 'TCP', port: portNumber(port) }] };
}
const ingress = [];
if (process.argv[3] !== undefined) {
  const gatewayNamespace = `${namespace.slice(0, -4)}-gateway`;
  // Keep both selectors in one peer: the namespace and Pod label must both match.
  const gateway = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': gatewayNamespace } },
    podSelector: { matchLabels: { app: 'opencrane-gateway' } },
  };
  ingress.push({ from: [gateway],
    ports: [{ protocol: 'TCP', port: portNumber(process.argv[3]) }] });
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
