import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as guard from './journey-guard.ts';

function startsCoreOnlyForOrdinarySecondaryStartup() {
  const { runsCoreAtStartup } = guard;
  assert.equal(runsCoreAtStartup(true, false, undefined), true);
  assert.equal(runsCoreAtStartup(true, false, '0'), true);
  assert.equal(runsCoreAtStartup(true, false, '1'), false);
  assert.equal(runsCoreAtStartup(true, true, undefined), false);
  assert.equal(runsCoreAtStartup(false, false, undefined), false);
}

test('focused startup defers browser checks until the demo is ready',
  startsCoreOnlyForOrdinarySecondaryStartup);
