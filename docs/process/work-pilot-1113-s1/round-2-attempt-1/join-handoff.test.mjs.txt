import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyJoinedWorkspace } from './join-handoff.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(function pending(complete) { resolve = complete; });
  return { promise, resolve };
}

test('prepares joined access before the first protected workspace read', async function preparesAccess() {
  const joined = deferred();
  const permitted = deferred();
  let accessApplied = false;
  let reads = 0;
  async function join() {
    joined.resolve();
    return { status: 'joined' };
  }
  async function accessReady() {
    await permitted.promise;
    accessApplied = true;
  }
  function openWorkspace() {
    reads += 1;
    return accessApplied ? 200 : 403;
  }
  const result = qualifyJoinedWorkspace(join, accessReady, openWorkspace);
  await joined.promise;
  await Promise.resolve();
  try {
    assert.equal(reads, 0, 'The fixture opens the workspace before joined access is applied');
  } finally {
    permitted.resolve();
  }
  assert.equal(await result, 200);
  assert.equal(reads, 1, 'The fixture retries the protected request');
});
