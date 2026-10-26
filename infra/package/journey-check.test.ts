import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJourney, checkHistoryRefusal, checkCollectorOwner } from './journey-check.ts';

const binding = {
  source: 'a'.repeat(40), image: `local/server@sha256:${'b'.repeat(64)}`,
  context: 'k3d-opencrane-target-1', namespace: 'opencrane-package-1',
  namespaceUid: 'namespace-1', releaseUid: 'release-1', installId: 'install-1',
  installedAt: '2026-10-26T12:00:00.000Z',
  pvcUids: ['pvc-1'], pvUids: ['pv-1'], storeId: 'store-1',
  origin: 'http://127.0.0.1:25106',
};
const outcomes = [
  { width: 1280, authenticated: true, subject: 'owner', chat: true, historyRefused: true },
  { width: 390, authenticated: true, subject: 'owner', chat: true, historyRefused: true },
];

function receipt() {
  return { binding: structuredClone(binding), outcomes: structuredClone(outcomes) };
}

function acceptsCurrentInstall() {
  const result = receipt();
  Object.assign(result.outcomes[0]!, { cookie: 'planted-secret' });
  assert.deepEqual(checkJourney(result, binding), outcomes);
}
test('only both widths from the current installation are accepted', acceptsCurrentInstall);

for (const field of Object.keys(binding)) {
  function refusesForeignBinding() {
    const result = receipt();
    Object.assign(result.binding, { [field]: 'foreign' });
    function accept() {
      checkJourney(result, binding);
    }
    assert.throws(accept, /Journey receipt belongs to another install/u);
  }
  test(`receipt with foreign ${field} refuses`, refusesForeignBinding);
}

for (const change of ['missing width', 'failed sign-in', 'failed chat', 'failed refusal']) {
  function refusesIncompleteCollector() {
    const result = receipt();
    if (change === 'missing width') result.outcomes.pop();
    if (change === 'failed sign-in') result.outcomes[0]!.authenticated = false;
    if (change === 'failed chat') result.outcomes[0]!.chat = false;
    if (change === 'failed refusal') result.outcomes[0]!.historyRefused = false;
    function accept() {
      checkJourney(result, binding);
    }
    assert.throws(accept);
  }
  test(`incomplete collector refuses: ${change}`, refusesIncompleteCollector);
}

function refusesNonLoopbackOrigin() {
  const foreign = { ...binding, origin: 'https://example.test' };
  function accept() {
    checkJourney({ ...receipt(), binding: foreign }, foreign);
  }
  assert.throws(accept, /Journey origin must be the claimed loopback address/u);
}
test('a non-loopback origin refuses even when the receipt agrees', refusesNonLoopbackOrigin);

function refusesProtectedBytes() {
  checkHistoryRefusal(401, '{"status":"refused"}');
  for (const [status, body] of [[200, 'protected'], [401, 'protected'],
    [401, '{"status":"refused","messages":["protected"]}']] as const) {
    function accept() {
      checkHistoryRefusal(status, body);
    }
    assert.throws(accept);
  }
}
test('unauthenticated history requires the exact refusal with no extra bytes', refusesProtectedBytes);

function refusesMissingInstall() {
  const owner = { context: binding.context, namespaceUid: binding.namespaceUid,
    releaseSecretUid: binding.releaseUid, installId: binding.installId };
  checkCollectorOwner(binding, owner);
  for (const changed of [undefined, { ...owner, installId: 'foreign' }]) {
    function collect() {
      checkCollectorOwner(binding, changed);
    }
    assert.throws(collect, /Collector requires the current owned install/u);
  }
}
test('collector refuses after teardown and for a foreign owned install', refusesMissingInstall);

function refusesStageB() {
  function substitute() {
    checkJourney({ screenshots: ['1280.png', '390.png'], status: 'PASS' }, binding);
  }
  assert.throws(substitute, /Journey receipt belongs to another install/u);
}
test('Stage B evidence cannot replace a packaged collector receipt', refusesStageB);
