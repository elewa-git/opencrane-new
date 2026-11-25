import '../dev-stack/journey-entry.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { directory, root } from '../dev-stack/config.ts';
import { stackId } from '../dev-stack/identity.ts';
import { targetConnection, targetRecorded } from '../dev-stack/target.ts';
import { runOnce } from './fresh-twice.ts';

async function runBudgetJourney() {
  const args = ['--experimental-strip-types', 'infra/package/provider-journey.test.mjs', '--budget'];
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const [code] = await once(child, 'close');
  return code === 0;
}

async function runBoundJourney(values: string) {
  assert(await targetRecorded(), 'Claim and prepare a dedicated k3d target first');
  const connection = await targetConnection();
  assert(connection.context === `k3d-opencrane-target-${stackId}`, 'Wrong journey target');
  await rm(`${directory}/package-journey.json`, { force: true });
  const first = await runOnce(1, values, undefined, true);
  const second = await runOnce(2, values, first, true);
  const receipt = { status: 'PARTIAL', runs: [first.journey, second.journey],
    notRun: ['P3-22/Odoo/OAuth', 'full P5-10', 'P5-12', 'native memory', 'routines',
      'full P4-28 (P5-13)'] };
  await writeFile(`${directory}/package-journey.json`, JSON.stringify(receipt) + '\n',
    { mode: 0o600 });
  console.log('PARTIAL packaged sign-in, stub chat and unauthenticated history at 1280/390');
}

try {
  assert(process.argv.length === 3, 'Pass --budget or the private values file path');
  const input = process.argv[2]!;
  if (input === '--budget') {
    if (!await runBudgetJourney()) process.exitCode = 1;
  } else {
    await runBoundJourney(input);
  }
} catch {
  console.error('FAIL packaged journey; inspect the claimed slot before retrying');
  process.exitCode = 1;
}
