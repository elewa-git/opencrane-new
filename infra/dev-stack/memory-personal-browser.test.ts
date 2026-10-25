import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { recordScopesResponse } from './memory-personal-browser.ts';

async function recordsStatusBeforeBody(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const records: Array<{ name: string; value: unknown }> = [];
  async function record(name: string, value: unknown) {
    records.push({ name, value });
  }
  function neverFinishes(): Promise<unknown> {
    return new Promise(function pending() {});
  }
  function status() {
    return 503;
  }
  const response = { status, json: neverFinishes };
  const pending = recordScopesResponse(response, record);
  await setImmediate();
  assert.deepEqual(records[0], { name: 'scopes', value: { status: 503 } });
  const rejected = assert.rejects(pending, /Memory scopes response body timed out/u);
  context.mock.timers.tick(10_000);
  await rejected;
  assert.deepEqual(records[1], { name: 'scopes_body', value: { status: 'unavailable' } });
}

test('records the reply status before a stalled body and stops after ten seconds',
  recordsStatusBeforeBody);

async function recordsCompleteReply(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const records: Array<{ name: string; value: unknown }> = [];
  const body = { scopes: [] };
  async function record(name: string, value: unknown) {
    records.push({ name, value });
  }
  async function json() {
    assert.deepEqual(records, [{ name: 'scopes', value: { status: 200 } }]);
    return body;
  }
  function status() {
    return 200;
  }
  assert.deepEqual(await recordScopesResponse({ status, json }, record), body);
  assert.deepEqual(records[1], { name: 'scopes_body', value: { status: 'read', body } });
  context.mock.timers.tick(10_000);
  assert.equal(records.length, 2);
}

test('records a complete response body separately and clears its timer', recordsCompleteReply);
