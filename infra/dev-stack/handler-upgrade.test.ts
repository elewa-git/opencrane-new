import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeBeforeApps } from './handler-upgrade.ts';

const command = 'npm run ops -- upgrade-handlers';

function report(plan: object[]) {
  const result = { dryRun: true, manifestChanged: plan.length > 0,
    plan, failedJobs: [] };
  return JSON.stringify(result);
}

async function emptyPlan() {
  const calls: string[] = [];
  async function execute(flag: string) {
    calls.push(flag);
    return `{"level":"info","msg":"scan complete"}\n${report([])}\n`;
  }
  await upgradeBeforeApps(execute);
  assert.deepEqual(calls, ['--dry-run']);
}

async function orderOnlyChange() {
  const calls: string[] = [];
  async function execute(flag: string) {
    calls.push(flag);
    const result = { manifestChanged: true, plan: [], failedJobs: [] };
    return JSON.stringify(result);
  }
  await upgradeBeforeApps(execute);
  assert.deepEqual(calls, ['--dry-run', '--confirm-writers-stopped']);
}

async function safePlans() {
  for (const change of [
    { handler: 'example', addedTypes: [], removedTypes: ['old'], eventCount: 0 },
    { handler: 'example', addedTypes: ['new'], removedTypes: [], eventCount: 3 },
  ]) {
    const calls: string[] = [];
    async function execute(flag: string) {
      calls.push(flag);
      return report([change]);
    }
    await upgradeBeforeApps(execute);
    assert.deepEqual(calls, ['--dry-run', '--confirm-writers-stopped']);
  }
}

async function unsafePlans() {
  const calls: string[] = [];
  async function execute(flag: string) {
    calls.push(flag);
    const change = { handler: 'example', addedTypes: [], removedTypes: ['old'], eventCount: 2 };
    return report([change]);
  }
  await assert.rejects(upgradeBeforeApps(execute), new RegExp(command));
  assert.deepEqual(calls, ['--dry-run']);
}

async function failedPreview() {
  async function execute(): Promise<string> {
    throw new Error('private-value-with-secret');
  }
  function checkError(error: unknown) {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(command));
    assert.doesNotMatch(error.message, /secret/u);
    return true;
  }
  await assert.rejects(upgradeBeforeApps(execute), checkError);
}

test('an empty handler plan leaves the stack unchanged', emptyPlan);
test('an order-only change updates the saved manifest', orderOnlyChange);
test('new subscriptions and changes without matching history apply before apps', safePlans);
test('removed subscriptions with matching history stop startup', unsafePlans);
test('preview failures name the operator command without exposing settings', failedPreview);
