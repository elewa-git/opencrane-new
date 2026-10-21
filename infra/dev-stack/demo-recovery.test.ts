import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { prepareDemo } from './demo-prepare.ts';
import { demoRecording } from './test/demo-recording.ts';

async function restoresFailedPreparation() {
  const fixture = await demoRecording();
  fixture.budget.dailyCeilingCents = 100;
  const output = `${fixture.options.directory}/demo-smoke/run-one`;
  try {
    await assert.rejects(prepareDemo(fixture.options, 700, output), /Personal assistant required/u);
    assert.equal(fixture.budget.ceilingCents, 100);
    assert.equal(fixture.budget.dailyCeilingCents, 100);
    assert.deepEqual(fixture.writes.map(ceiling), [700, 100]);
    await assert.rejects(readFile(`${output}/saved-ceilings.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
function ceiling(command: Record<string, unknown>) { return command['ceilingCents']; }
test('preparation restores 100-cent ceilings after raising to 700 then receiving HTTP 503',
  restoresFailedPreparation);
