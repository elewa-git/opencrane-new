import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedFixture } from './test/mcp-hosted-fixture.ts';

function deletes(calls: string[][]) {
  function deletion(call: string[]) {
    return call.includes('delete');
  }
  return calls.filter(deletion);
}
test('a replacement namespace prevents every cleanup deletion', async function replacement() {
  const fixture = hostedFixture();
  await fixture.setup();
  const namespace = fixture.objects.get('namespace/opencrane-dev-1-fixture--mcp')!;
  namespace.metadata.uid = 'replacement';
  await assert.rejects(fixture.cleanup);
  assert.deepEqual(deletes(fixture.calls), []);
});
test('a replacement policy prevents every cleanup deletion', async function replacement() {
  const fixture = hostedFixture();
  await fixture.setup();
  const policy = fixture.objects.get(
    'validatingadmissionpolicy/opencrane-dev-1-fixture--mcp-pod')!;
  policy.metadata.uid = 'replacement';
  await assert.rejects(fixture.cleanup);
  assert.deepEqual(deletes(fixture.calls), []);
});
test('a partial isolated policy installation is removed by final cleanup', async function partial() {
  const fixture = hostedFixture();
  await fixture.setup();
  fixture.failBinding('opencrane-dev-1-mcp-fixture--isolated');
  const devices = fixture.cases.get('denies devices')!;
  await assert.rejects(devices);
  await fixture.cleanup();
  assert.equal(fixture.objects.size, 0);
});
test('partial setup removes all successfully created policies and namespaces', async function partial() {
  const fixture = hostedFixture();
  fixture.failBinding('opencrane-dev-1-fixture--mcp-pod');
  await assert.rejects(fixture.setup);
  await fixture.cleanup();
  assert.equal(fixture.objects.size, 0);
});
test('hosted resize waits for Pod deletion and quota usage to settle', async function resize() {
  const fixture = hostedFixture();
  await fixture.setup();
  await fixture.cases.get('denies hosted Pod resize')!();
  assert.ok(fixture.sleeps >= 2, 'Quota observation must finish before the next quota test');
});

test('quota settling has a fixed deadline and never starts the next workload early', async function deadline() {
  const fixture = hostedFixture();
  await fixture.setup();
  fixture.holdQuota();
  const quota = fixture.cases.get('admits four Pods and refuses a fifth through quota')!;
  await assert.rejects(quota, /quota usage did not settle/u);
  assert.equal(fixture.sleeps, 60);
});
test('replacement binding and changed ownership label refuse cleanup', async function binding() {
  for (const property of ['uid', 'labels']) {
    const fixture = hostedFixture();
    await fixture.setup();
    const binding = fixture.objects.get(
      'validatingadmissionpolicybinding/opencrane-dev-1-fixture--mcp-pod')!;
    if (property === 'uid') binding.metadata.uid = 'replacement';
    else binding.metadata.labels = { 'opencrane.dev/fixture-owner': 'foreign' };
    await assert.rejects(fixture.cleanup, /ownership changed/u);
    assert.deepEqual(deletes(fixture.calls), []);
  }
});

test('cleanup recovers an owned policy after a lost create response without leaking output', async function lost() {
  const fixture = hostedFixture();
  fixture.loseCreateResponse('opencrane-dev-1-fixture--mcp-statefulset');
  await assert.rejects(fixture.setup, function safe(error: Error) {
    assert.doesNotMatch(error.message, /private-create-response/u);
    return true;
  });
  await fixture.cleanup();
  assert.equal(fixture.objects.size, 0);
});
test('owner and fleet runs stop before any Kubernetes call', async function guard() {
  const environments = [
    { MCP_HOSTED_K3D: '1', DEV_STACK_ID: 'owner' },
    { MCP_HOSTED_K3D: '1', DEV_STACK_ID: '1', OPENCRANE_FLEET_TASK: '' },
  ];
  for (const environment of environments) {
    const fixture = hostedFixture(environment);
    await assert.rejects(fixture.setup, /secondary stack and no fleet task/u);
    assert.deepEqual(fixture.calls, []);
  }
});
