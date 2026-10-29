import { collectDeployment } from './deployment.ts';

const result = collectDeployment(...process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.result !== 'PASS') {
  process.exitCode = 1;
}
