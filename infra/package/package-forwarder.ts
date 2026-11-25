import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { root } from '../dev-stack/config.ts';

const execute = promisify(execFile);
const launcherArgs = ['node', '--experimental-strip-types', 'infra/package/forward.ts'];

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
  const [, , , address, , owner] = listeners[0]!.split(/\s+/u);
  if (address !== `127.0.0.1:${port}`) {
    return undefined;
  }
  const process = /^users:\(\("kubectl",pid=(\d+),fd=\d+\)\)$/u.exec(owner ?? '');
  return process?.[1];
}

async function processArgs(pid: string) {
  const argumentsFile = await readFile(`/proc/${pid}/cmdline`, 'utf8');
  const args = argumentsFile.split('\0');
  return args.slice(0, -1);
}

async function launchedFromPackage(pid: string, args: string[]) {
  const actual = await processArgs(pid);
  if (!isDeepStrictEqual(actual, ['kubectl', ...args])) {
    return false;
  }
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const parent = /^PPid:\s+(\d+)$/mu.exec(status)?.[1];
  if (!parent) {
    return false;
  }
  const parentArgs = await processArgs(parent);
  const checkout = await readlink(`/proc/${parent}/cwd`);
  return checkout === root && isDeepStrictEqual(parentArgs, launcherArgs);
}

export async function ownsPackageForwarder(origin: string, args: string[]) {
  const { port } = new URL(origin);
  const pid = await listeningPid(port);
  if (!pid) {
    return false;
  }
  // Match the listener to the checked namespace and to the launcher in this checkout.
  return launchedFromPackage(pid, args);
}
