import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function executeKube(args: string[], deadline: number, input?: Buffer): Promise<string> {
  function execute(resolve: (value: string) => void, reject: (reason: Error) => void) {
    const timeout = Math.min(65_000, deadline - Date.now());
    if (timeout < 1) {
      const error = new Error('Pilot restore deadline exceeded');
      reject(error);
      return;
    }
    const options = { timeout, maxBuffer: 1024 * 1024 };
    function completed(error: Error | null, stdout: string) {
      if (error) {
        const options = { cause: error };
        const failure = new Error('Kubernetes restore operation failed', options);
        reject(failure);
      } else {
        resolve(stdout);
      }
    }
    const child = execFile('kubectl', args, options, completed);
    function inputFailed(cause: Error) {
      child.kill('SIGTERM');
      const options = { cause };
      const failure = new Error('Restore input failed', options);
      reject(failure);
    }
    child.stdin?.on('error', inputFailed);
    child.stdin?.end(input);
  }
  return new Promise<string>(execute);
}

/** Keep private bytes out of arguments, and command errors inside the rejected promise. */
export async function restoreKube(args: string[], deadline: number, input?: Buffer) {
  const patchArgument = '--patch-file=/dev/stdin';
  if (!args.includes(patchArgument)) {
    return executeKube(args, deadline, input);
  }
  if (!input) {
    throw new Error('Kubernetes patch input is missing');
  }
  // Use a private regular file: kubectl cannot reopen Node's stdin socket as a file.
  // The Job mounts its temporary directory in memory and removes it with the Pod.
  const prefix = join(tmpdir(), 'pilot-patch-');
  const directory = await mkdtemp(prefix);
  try {
    const path = join(directory, 'patch.json');
    const options = { mode: 0o600, flag: 'wx' };
    await writeFile(path, input, options);
    const command: string[] = [];
    for (const argument of args) {
      if (argument === patchArgument) {
        command.push(`--patch-file=${path}`);
      } else {
        command.push(argument);
      }
    }
    return await executeKube(command, deadline);
  } finally {
    const options = { recursive: true, force: true };
    await rm(directory, options);
  }
}
