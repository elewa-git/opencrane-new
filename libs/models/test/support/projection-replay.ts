import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function projectionReplay(env: NodeJS.ProcessEnv, argumentsForReplay: string[]) {
  // Own the replay process directly, so the deadline cannot leave an npm grandchild running.
  const args = ['--experimental-strip-types', 'apps/ops/src/replay.ts', ...argumentsForReplay];
  const options = { env, timeout: 10_000 };
  return execute(process.execPath, args, options);
}
