import { execFile } from 'node:child_process';

/** Keep SQL and patch values on stdin; dependency output stays inside the rejected promise. */
export function restoreKube(args: string[], deadline: number, input?: Buffer): Promise<string> {
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
