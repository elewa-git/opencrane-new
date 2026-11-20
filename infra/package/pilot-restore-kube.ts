import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function executeKube(args: string[], deadline: number, input?: Buffer): Promise<string> {
  return new Promise(function execute(resolve, reject) {
    const timeout = Math.min(65_000, deadline - Date.now());
    if (timeout < 1) {
      reject(new Error('Pilot restore deadline exceeded'));
      return;
    }
    const options = { timeout, maxBuffer: 1024 * 1024 };
    function completed(error: Error | null, stdout: string) {
      if (error) reject(new Error('Kubernetes restore operation failed', { cause: error }));
      else resolve(stdout);
    }
    const child = execFile('kubectl', args, options, completed);
    function inputFailed(cause: Error) {
      child.kill('SIGTERM');
      reject(new Error('Restore input failed', { cause }));
    }
    child.stdin?.on('error', inputFailed);
    child.stdin?.end(input);
  });
}

/** Keep private input out of arguments and dependency output inside the rejected promise. */
export async function restoreKube(args: string[], deadline: number, input?: Buffer) {
  const patchArgument = '--patch-file=/dev/stdin';
  if (!args.includes(patchArgument)) return executeKube(args, deadline, input);
  if (!input) throw new Error('Kubernetes patch input is missing');
  // Use a private regular file: kubectl cannot reopen Node's stdin socket as a file.
  // The Job mounts its temporary directory in memory and removes it with the Pod.
  const directory = await mkdtemp(join(tmpdir(), 'pilot-patch-'));
  try {
    const path = join(directory, 'patch.json');
    await writeFile(path, input, { mode: 0o600, flag: 'wx' });
    const command: string[] = [];
    for (const argument of args) {
      if (argument === patchArgument) command.push(`--patch-file=${path}`);
      else command.push(argument);
    }
    return await executeKube(command, deadline);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
