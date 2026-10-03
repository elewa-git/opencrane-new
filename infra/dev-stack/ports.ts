import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** Refuse occupied ports unless their listener belongs to this stack's running processes or Compose project. */
export async function checkPorts(settings: Record<string, string>, pids: Array<number | undefined>, project: string) {
  const ports = Object.entries(settings).filter(([name]) => name.endsWith('_PORT')).map(([, port]) => port);
  if (new Set(ports).size !== ports.length) throw new Error('Stack ports must be distinct');
  const containers = (await exec('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'])).stdout.trim().split('\n').filter(Boolean);
  const published = new Set<string>();
  if (containers.length) {
    const inspected = JSON.parse((await exec('docker', ['inspect', ...containers])).stdout) as Array<{
      NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> }
    }>;
    for (const container of inspected) for (const bindings of Object.values(container.NetworkSettings.Ports)) {
      for (const binding of bindings ?? []) if (binding.HostIp === '127.0.0.1') published.add(binding.HostPort);
    }
  }
  const listeners = (await exec('ss', ['-H', '-ltnp'])).stdout.split('\n');
  for (const port of ports) {
    for (const host of ['127.0.0.1', '::1']) {
      const free = await new Promise<boolean>((resolve, reject) => {
        const server = createServer();
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') resolve(false);
          else if (error.code === 'EAFNOSUPPORT' && host === '::1') resolve(true);
          else reject(error);
        });
        server.listen({ host, port: Number(port), exclusive: true }, () => server.close(() => resolve(true)));
      });
      if (free) continue;
      if (host === '127.0.0.1' && published.has(port)) continue;
      const matching = listeners.filter(line => line.trim().split(/\s+/u)[3]?.endsWith(`:${port}`));
      let owned = matching.length > 0;
      for (const line of matching) {
        const matches = [...line.matchAll(/pid=(\d+),/gu)];
        if (!matches.length) owned = false;
        for (const match of matches) {
          const stat = await readFile(`/proc/${match[1]}/stat`, 'utf8');
          const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
          if (!pids.includes(group)) owned = false;
        }
      }
      if (!owned) throw new Error(`Port ${port} is already in use outside this stack`);
    }
  }
}
