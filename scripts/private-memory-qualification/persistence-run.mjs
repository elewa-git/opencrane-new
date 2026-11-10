import { runDeploymentPersistenceAttempt } from './persistence-deployment.ts';

const controller = new AbortController();
function cancel() {
  controller.abort();
}
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(name, cancel);
}
const result = await runDeploymentPersistenceAttempt(controller.signal);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.result !== 'PARTIAL') {
  process.exitCode = 1;
}
