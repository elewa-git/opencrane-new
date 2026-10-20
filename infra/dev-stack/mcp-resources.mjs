import { execFileSync } from 'node:child_process';

const namespace = process.argv[2];
if (!namespace || !/^[a-z0-9-]+$/.test(namespace)) {
  throw new Error('Expected MCP namespace');
}
const quota = { apiVersion: 'v1', kind: 'ResourceQuota',
  metadata: { name: 'mcp-limit', namespace },
  spec: { hard: { pods: '4', 'requests.cpu': '400m', 'requests.memory': '1Gi',
    'limits.cpu': '4', 'limits.memory': '2Gi' } } };
try {
  execFileSync('kubectl', ['--context=k3d-ocn', 'apply', '-f', '-'],
    { input: JSON.stringify(quota), stdio: ['pipe', 'pipe', 'pipe'] });
} catch {
  throw new Error('Could not install hosted MCP namespace resources');
}
