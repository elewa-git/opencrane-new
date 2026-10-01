import type { ChildProcess } from 'node:child_process';

/** Wait for our child to exit, including after a forced stop. */
export async function stopChild(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.kill('SIGTERM');
  });
}
