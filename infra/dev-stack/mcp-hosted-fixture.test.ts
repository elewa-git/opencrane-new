import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedFixture } from './test/mcp-hosted-fixture.ts';

function deletes(calls: string[][]) {
  return calls.filter(function deletion(call) { return call.includes('delete'); });
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
