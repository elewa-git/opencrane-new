import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { root } from '../dev-stack/config.ts';
import { z } from 'zod';

const execute = promisify(execFile);
const launcherArgs = ['node', '--experimental-strip-types', 'infra/package/forward.ts'];
const targetVariable = 'OPENCRANE_FORWARD_TARGET';
const namespacesSchema = z.object({ items: z.array(z.object({
  metadata: z.object({ name: z.string(), uid: z.string().regex(/^[a-z0-9-]+$/iu) }),
})) });

export type ForwardTarget = { clusterUid: string; namespaceUid: string };

function targetIdentity(target: ForwardTarget) {
  return `${target.clusterUid}/${target.namespaceUid}`;
}

export function forwardEnvironment(environment: NodeJS.ProcessEnv, target: ForwardTarget) {
  return { ...environment, [targetVariable]: targetIdentity(target) };
}

export async function readForwardTarget(connection: {
  args: string[]; environment: NodeJS.ProcessEnv;
}, namespace: string, namespaceUid: string): Promise<ForwardTarget> {
  const args = [...connection.args, 'get', 'namespace', 'kube-system', namespace, '-o', 'json'];
  const result = await execute('kubectl', args, { env: connection.environment, timeout: 5000 });
  const { items } = namespacesSchema.parse(JSON.parse(result.stdout));
  const identities = new Map<string, string>();
  for (const { metadata } of items) identities.set(metadata.name, metadata.uid);
  const clusterUid = identities.get('kube-system');
  if (!clusterUid || identities.get(namespace) !== namespaceUid) {
    throw new Error('Forwarding target differs from the checked package');
  }
  return { clusterUid, namespaceUid };
}

export function packageForwardArgs(connectionArgs: string[], namespace: string, origin: string) {
  const { port } = new URL(origin);
  return [...connectionArgs, '-n', namespace,
    'port-forward', '--address', '127.0.0.1', 'service/web', `${port}:80`];
}

async function listeningPid(port: string) {
  const result = await execute('ss', ['-H', '-ltnp', `sport = :${port}`], { timeout: 5000 });
  const output = result.stdout.trim();
  const listeners = output.split('\n');
  if (listeners.length !== 1) {
    return undefined;
  }
  const [, , , localAddress, , processOwner] = listeners[0]!.split(/\s+/u);
  if (localAddress !== `127.0.0.1:${port}`) {
    return undefined;
  }
  const process = /^users:\(\("kubectl",pid=(\d+),fd=\d+\)\)$/u.exec(processOwner ?? '');
  return process?.[1];
}

async function processArgs(pid: string) {
  const argumentsFile = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  const args = argumentsFile.split('\0');
  return args.slice(0, -1);
}

async function launchedFromPackage(pid: string, args: string[], target: ForwardTarget) {
  const actual = await processArgs(pid);
  if (!isDeepStrictEqual(actual, ['kubectl', ...args])) {
    return false;
  }
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const parent = /^PPid:\s+(\d+)$/mu.exec(status)?.[1];
  if (!parent) {
    return false;
  }
  // Check the launcher too. A manually started kubectl can use the same command arguments.
  const parentArgs = await processArgs(parent);
  const checkout = await readlink(`/proc/${parent}/cwd`);
  if (checkout !== root || !isDeepStrictEqual(parentArgs, launcherArgs)) return false;
  const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
  const settings = environment.split('\0');
  return settings.includes(`${targetVariable}=${targetIdentity(target)}`);
}

export async function ownsPackageForwarder(origin: string, args: string[], target: ForwardTarget) {
  const { port } = new URL(origin);
  const pid = await listeningPid(port);
  if (!pid) {
    return false;
  }
  // Check the listening process first so a healthy response alone cannot identify it.
  return launchedFromPackage(pid, args, target);
}
