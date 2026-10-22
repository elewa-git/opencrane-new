import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { testArguments } from './fixture-tests.mjs';

const directoryOptions = { recursive: true };
mkdirSync('.tools/ci', directoryOptions);
const argumentsList = testArguments(process.argv[2]);
const npmArguments = ['test', '--', ...argumentsList];
const executionOptions = { stdio: 'inherit' };
const result = spawnSync('npm', npmArguments, executionOptions);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
