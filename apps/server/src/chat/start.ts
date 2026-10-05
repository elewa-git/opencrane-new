import type { Client } from 'minio/dist/esm/minio.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tokenIssuer } from '@opencrane/auth';
import { createLogger } from '@opencrane/observability';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { watchBridges } from './bridge.ts';
import type { ChatOptions } from './routes.ts';

/** The dev host reaches private Pods through its scoped Kubernetes identity. No public listener. */
export async function startBridges(options: ChatOptions & { objects?: Client }, kubeconfig: string, namespace: string, privateKeyPath: string, issuer: string) {
  const tokens = await tokenIssuer({ privateKeyPath, issuer });
  const child = spawn('kubectl', ['--kubeconfig', kubeconfig, 'proxy', '--address=127.0.0.1', '--port=0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Kubernetes bridge proxy timeout')); }, 10_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Kubernetes bridge proxy unavailable')); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Kubernetes bridge proxy exited')); });
    createInterface({ input: child.stdout }).on('line', line => {
      const port = /127\.0\.0\.1:(\d+)/u.exec(line)?.[1]; if (port) { clearTimeout(timeout); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  const stop = new AbortController();
  const work = watchBridges(options, tokens, new SandboxClient(kubeconfig, namespace), url, stop.signal);
  function watcherFailed(error: unknown) {
    const logger = createLogger('bridge');
    const details = { err: error };
    logger.fatal(details, 'Bridge watcher stopped; restarting the server');
    stop.abort();
    child.kill();
    process.exit(1);
  }
  void work.catch(watcherFailed);
  return async () => { stop.abort(); child.kill(); await work; };
}
