import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { startConnectionCustodyBridge } from './connection-custody-bridge.ts';

process.umask(0o077);
const socketPath = process.env['CONNECTION_CUSTODY_SOCKET'];
const kubeconfig = process.env['CONNECTION_CUSTODY_KUBECONFIG'];
const namespace = process.env['CONNECTION_CUSTODY_NAMESPACE'];
const port = Number(process.env['CUSTODY_PROXY_PORT']);
if (!socketPath || !kubeconfig || !namespace || !Number.isInteger(port)) {
  throw new Error('Connection custody proxy settings required');
}
await rm(socketPath, { force: true });
const args = ['--kubeconfig', kubeconfig, 'proxy', '--unix-socket', socketPath,
  '--accept-paths', `^/api/v1/namespaces/${namespace}/secrets(/[^/]+)?$`];
const child = spawn('kubectl', args, { stdio: ['ignore', 'ignore', 'inherit'] });
const close = await startConnectionCustodyBridge(socketPath, port);
function stop() {
  close();
  child.kill('SIGTERM');
}
function exited(code: number | null) {
  close();
  process.exitCode = code ?? 1;
}
child.once('exit', exited);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
