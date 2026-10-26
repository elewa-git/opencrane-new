import '../dev-stack/journey-entry.ts';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { directory } from '../dev-stack/config.ts';
import { stackId } from '../dev-stack/identity.ts';
import { targetConnection, targetRecorded } from '../dev-stack/target.ts';
import { runOnce } from './fresh-twice.ts';

try {
  assert(process.argv.length === 3, 'Pass the private values file path');
  assert(await targetRecorded(), 'Claim and prepare a dedicated k3d target first');
  const connection = await targetConnection();
  assert(connection.context === `k3d-opencrane-target-${stackId}`, 'Wrong journey target');
  await rm(`${directory}/package-journey.json`, { force: true });
  const first = await runOnce(1, process.argv[2]!, undefined, true);
  const second = await runOnce(2, process.argv[2]!, first, true);
  const receipt = { status: 'PARTIAL', runs: [first.journey, second.journey],
    notRun: ['P3-22/Odoo/OAuth', 'full P5-10', 'P5-12', 'native memory', 'routines',
      'full P4-28 (P5-13)'] };
  await writeFile(`${directory}/package-journey.json`, JSON.stringify(receipt) + '\n',
    { mode: 0o600 });
  console.log('PARTIAL packaged sign-in, stub chat and unauthenticated history at 1280/390');
} catch {
  console.error('FAIL packaged journey; inspect the claimed slot before retrying');
  process.exitCode = 1;
}
