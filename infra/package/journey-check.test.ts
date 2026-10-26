import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJourney, checkHistoryRefusal } from './journey-check.ts';

const binding = {
  source: 'a'.repeat(40), image: `local/server@sha256:${'b'.repeat(64)}`,
  context: 'k3d-opencrane-target-1', namespace: 'opencrane-package-1',
  namespaceUid: 'namespace-1', releaseUid: 'release-1', installId: 'install-1',
  pvcUids: ['pvc-1'], storeId: 'store-1', origin: 'http://127.0.0.1:25106',
};
const outcomes = [
  { width: 1280, authenticated: true, subject: 'owner', chat: true, historyRefused: true },
  { width: 390, authenticated: true, subject: 'owner', chat: true, historyRefused: true },
];

function receipt() {
  return { binding: structuredClone(binding), outcomes: structuredClone(outcomes) };
}

test('only both widths from the current installation are accepted', () => {
  assert.deepEqual(checkJourney(receipt(), binding), outcomes);
});

for (const field of Object.keys(binding)) {
  test(`receipt with foreign ${field} refuses`, () => {
    const result = receipt();
    Object.assign(result.binding, { [field]: 'foreign' });
    function accept() {
      checkJourney(result, binding);
    }
    assert.throws(accept, /Journey receipt belongs to another install/u);
  });
}

for (const change of ['missing width', 'failed sign-in', 'failed chat', 'failed refusal']) {
  test(`incomplete collector refuses: ${change}`, () => {
    const result = receipt();
    if (change === 'missing width') result.outcomes.pop();
    if (change === 'failed sign-in') result.outcomes[0]!.authenticated = false;
    if (change === 'failed chat') result.outcomes[0]!.chat = false;
    if (change === 'failed refusal') result.outcomes[0]!.historyRefused = false;
    function accept() {
      checkJourney(result, binding);
    }
    assert.throws(accept);
  });
}

test('a non-loopback origin refuses even when the receipt agrees', () => {
  const foreign = { ...binding, origin: 'https://example.test' };
  function accept() {
    checkJourney({ ...receipt(), binding: foreign }, foreign);
  }
  assert.throws(accept, /Journey origin must be the claimed loopback address/u);
});

test('unauthenticated history requires the exact refusal with no extra bytes', () => {
  checkHistoryRefusal(401, '{"status":"refused"}');
  for (const [status, body] of [[200, 'protected'], [401, 'protected'],
    [401, '{"status":"refused","messages":["protected"]}']] as const) {
    function accept() {
      checkHistoryRefusal(status, body);
    }
    assert.throws(accept);
  }
});
