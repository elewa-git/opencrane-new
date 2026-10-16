import { spawn } from 'node:child_process';
import type { StopExecution, StopInput } from '../chat/bridge-pausing.ts';

// Use authenticated root Pod exec. Ignore stderr and return only bounded JSON for checking.
export function executorStop(kubeconfig: string, namespace: string): StopExecution {
  function stop(input: StopInput): Promise<unknown> {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(input.computerId)) {
      return Promise.reject(new Error('Stop unavailable'));
    }
    const args = ['--kubeconfig', kubeconfig, '--namespace', namespace,
      'exec', '-i', input.computerId, '-c', 'computer', '--',
      '/usr/bin/env', '-u', 'NODE_OPTIONS', '/usr/local/bin/node', '--disable-sigusr1',
      '--experimental-strip-types', '/app/src/stop-executor.ts'];
    function execute(resolve: (value: unknown) => void, reject: (error: Error) => void) {
      const options = { stdio: ['pipe', 'pipe', 'ignore'] as ['pipe', 'pipe', 'ignore'],
        timeout: 15_000, killSignal: 'SIGKILL' as const };
      const child = spawn('kubectl', args, options);
      let output = '';
      function failed() {
        child.kill('SIGKILL');
        reject(new Error('Stop unavailable'));
      }
      function collect(chunk: Buffer) {
        if (Buffer.byteLength(output) + chunk.length > 16_384) {
          failed();
          return;
        }
        output += chunk.toString();
      }
      function finished(code: number | null) {
        if (code !== 0) return failed();
        try { resolve(JSON.parse(output) as unknown); }
        catch { failed(); }
      }
      child.stdout.on('data', collect);
      child.stdout.on('error', failed);
      child.stdin.on('error', failed);
      child.on('error', failed);
      child.once('close', finished);
      child.stdin.end(JSON.stringify(input));
    }
    return new Promise(execute);
  }
  return stop;
}
