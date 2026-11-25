import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { directory, root } from '../dev-stack/config.ts';
import { localOrigin } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';
import {
  forwardEnvironment, packageForwardArgs, readForwardTarget,
} from './package-forwarder.ts';

const execute = promisify(execFile);

async function forward(args: string[], environment: NodeJS.ProcessEnv) {
  const child = spawn('kubectl', args, {
    cwd: root, env: environment, stdio: 'ignore' });
  function stop() {
    child.kill('SIGTERM');
  }
  // Stop the owned forwarder when the fresh-install runner stops this launcher.
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  function waitForExit(resolve: () => void, reject: (error: Error) => void) {
    function failed() {
      reject(new Error('Package forward failed'));
    }
    function closed(code: number | null, signal: NodeJS.Signals | null) {
      if (code === 0 || signal === 'SIGTERM') {
        resolve();
      } else {
        failed();
      }
    }
    child.once('error', failed);
    child.once('close', closed);
  }
  try {
    await new Promise<void>(waitForExit);
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

async function main() {
  const owner = await verifyPackageOwner();
  const connection = await packageConnectionArgs(owner);
  const scratch = await mkdtemp(join(directory, 'forward-'));
  try {
    const args = [...connection.args, 'config', 'view', '--raw', '--minify', '--flatten'];
    const config = await execute('kubectl', args,
      { env: connection.environment, timeout: 5000, maxBuffer: 1024 * 1024 });
    const path = join(scratch, 'connection.yaml');
    await writeFile(path, config.stdout, { mode: 0o400, flag: 'wx' });
    // Use the same private copy to check the target and to open the listener.
    const environment = { ...connection.environment, KUBECONFIG: path };
    const snapshot = { args: connection.args, environment };
    const target = await readForwardTarget(snapshot, owner.namespace, owner.namespaceUid);
    const forwardArgs = packageForwardArgs(snapshot.args, owner.namespace, localOrigin);
    await forward(forwardArgs, forwardEnvironment(environment, target));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function failed() {
  // Withhold dependency output because it can contain private connection settings.
  console.error('FAIL package forward');
  process.exitCode = 1;
}

await main().catch(failed);
