import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function loadsTheRunnerBeforeItsSlotRefusal() {
  const environment = { ...process.env, DEV_STACK_ID: 'invalid' };
  let stderr = '';
  try {
    await execute(process.execPath, ['--experimental-strip-types',
      'infra/package/qualification-signin.mjs'], { env: environment });
    assert.fail('The qualification runner accepted an invalid slot');
  } catch (error) {
    assert.equal(error.code, 1);
    stderr = error.stderr;
  }
  assert(!stderr.includes('ERR_MODULE_NOT_FOUND'), 'Runner cannot resolve its local helpers');
  assert(stderr.includes('Only a claimed secondary slot may run this journey'),
    'Runner did not reach its slot guard');
}

test('the executable qualification runner resolves its helpers before checking the slot',
  loadsTheRunnerBeforeItsSlotRefusal);
