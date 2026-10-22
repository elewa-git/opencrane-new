import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { testArguments } from './fixture-tests.mjs';

function runNpm(argumentsList) {
  const executionOptions = { stdio: 'inherit' };
  const result = spawnSync('npm', argumentsList, executionOptions);
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

const group = process.argv[2];
const argumentsList = testArguments(group);
const directoryOptions = { recursive: true };
mkdirSync('.tools/ci', directoryOptions);
if (group === 'fixtures') {
  // Warm Angular's compiler cache before tests start their own short-lived servers.
  const buildArguments = ['run', 'build', '-w', 'apps/web', '--', '--configuration=development'];
  const buildStatus = runNpm(buildArguments);
  if (buildStatus !== 0) {
    process.exit(buildStatus);
  }
}
const npmArguments = ['test', '--', ...argumentsList];
process.exit(runNpm(npmArguments));
