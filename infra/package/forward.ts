import { spawn } from 'node:child_process';
import { root } from '../dev-stack/config.ts';
import { localOrigin } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';
import { packageForwardArgs } from './package-forwarder.ts';

async function main() {
  const owner = await verifyPackageOwner();
  const connection = await packageConnectionArgs(owner);
  const args = packageForwardArgs(connection.args, owner.namespace, localOrigin);
  const child = spawn('kubectl', args, {
    cwd: root, env: connection.environment, stdio: 'ignore' });
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

function failed() {
  // Withhold dependency output because it can contain private connection settings.
  console.error('FAIL package forward');
  process.exitCode = 1;
}

await main().catch(failed);
