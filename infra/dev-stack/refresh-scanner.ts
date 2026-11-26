import { checkedRelease, ownedKubectl } from './packaged.ts';
import { refreshScanner } from '../package/scanner-refresh.mjs';

export async function refreshPackageScanner(expectedImage?: string) {
  const owner = await checkedRelease();

  function run(args: string[], timeoutMs?: number) {
    return ownedKubectl(owner, ['--namespace', owner.namespace, ...args], timeoutMs);
  }

  const result = await refreshScanner(run, expectedImage);
  const outcomes = {
    updated: 'The new scanner is ready',
    current: 'The approved scanner is already running',
    'newer-installed': 'The running scanner is at least as fresh as the available approval',
  };
  console.log(`PASS ${outcomes[result.status]}. GitHub run ${result.runId}.`);
  console.log(`${result.image}. Manifest ${result.sha}.`);
  console.log(`The active virus list was checked at ${result.databaseUpdatedAt}.`);
  if (result.cleanupPending) {
    console.warn('The previous approval remains until cleanup or its original expiry.');
  }
}
