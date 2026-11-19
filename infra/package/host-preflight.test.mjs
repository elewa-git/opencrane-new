import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHost, hostFailures } from './host-preflight.mjs';

const emptySwaps = 'Filename\tType\tSize\tUsed\tPriority\n';
const randomSwap = 'cryptswap /dev/sda2 /dev/urandom plain,swap,cipher=aes-xts-plain64,size=256\n';
function fixture() {
  return { swaps: emptySwaps, corePattern: '\n', coreUsesPid: '0\n', crypttab: '', mappings: [] };
}
function encryptedFixture() {
  const state = fixture();
  state.swaps += '/dev/dm-0 partition 8192 0 -2\n';
  state.crypttab = randomSwap;
  state.mappings = [{ path: '/dev/dm-0', name: 'cryptswap', uuid: 'CRYPT-PLAIN-cryptswap' }];
  return state;
}
test('swap off and crash dumps off pass', function safeHost() {
  assert.deepEqual(hostFailures(fixture()), []);
});
test('active plain encrypted swap with a boot random key passes', function randomKey() {
  assert.deepEqual(hostFailures(encryptedFixture()), []);
});
const swapCases = [
  ['unencrypted swap', '/swapfile file 8192 0 -2\n'],
  ['unverified mapper', '/dev/mapper/cryptswap partition 8192 0 -2\n'],
  ['malformed swap list', 'unknown\n'],
];
for (const [name, swaps] of swapCases) {
  test(`refuse ${name} with the exact F1 fix`, function unsafeSwap() {
    const state = fixture();
    state.swaps = swaps;
    assert.match(hostFailures(state).join('\n'), /F1:.*disable swap.*fresh random key at each boot/u);
  });
}
const crypttabCases = [
  '',
  randomSwap.replace('/dev/urandom', '/etc/swap.key'),
  randomSwap.replace('plain,', 'luks,'),
  randomSwap.replace('plain,', ''),
  randomSwap.replace('swap,', ''),
  randomSwap.replace('plain,', 'plain,noauto,'),
  randomSwap + randomSwap,
];
for (const crypttab of crypttabCases) {
  test(`refuse unproved boot encryption ${JSON.stringify(crypttab)}`, function unsafeBoot() {
    const state = encryptedFixture();
    state.crypttab = crypttab;
    assert.match(hostFailures(state).join('\n'), /F1:/u);
  });
}
test('a crypttab name alone cannot prove active encryption', function inactiveEncryption() {
  const state = encryptedFixture();
  state.mappings[0].uuid = 'LVM-not-encrypted';
  assert.match(hostFailures(state).join('\n'), /F1:/u);
});
test('every active swap entry must pass', function mixedSwap() {
  const state = encryptedFixture();
  state.swaps += '/swapfile file 8192 0 -2\n';
  assert.match(hostFailures(state).join('\n'), /F1:/u);
});
const dumpCases = ['|/usr/share/apport/apport %p\n', '|/bin/false\n', 'core\n',
  '/var/crash/core.%p\n', '/dev/null\n', ' \n', ''];
for (const corePattern of dumpCases) {
  test(`refuse crash output ${JSON.stringify(corePattern)} with the F2 fix`, function dumps() {
    const state = fixture();
    state.corePattern = corePattern;
    assert.match(hostFailures(state).join('\n'), /F2:.*core_pattern.*core_uses_pid=0/u);
  });
}
test('empty pattern with PID suffix still persists a dump', function pidSuffix() {
  const state = fixture();
  state.coreUsesPid = '1\n';
  assert.match(hostFailures(state).join('\n'), /F2:/u);
});
test('report both host failures together', function bothFailures() {
  const state = fixture();
  state.swaps += '/swapfile file 8192 0 -2\n';
  state.corePattern = '|apport\n';
  assert.equal(hostFailures(state).length, 2);
});

test('read fixture host files without changing them, and refuse missing observations', function hostFiles() {
  const directory = mkdtempSync(join(tmpdir(), 'host-preflight-'));
  try {
    mkdirSync(`${directory}/proc/sys/kernel`, { recursive: true });
    mkdirSync(`${directory}/etc`);
    writeFileSync(`${directory}/proc/swaps`, emptySwaps);
    writeFileSync(`${directory}/proc/sys/kernel/core_pattern`, '\n');
    writeFileSync(`${directory}/proc/sys/kernel/core_uses_pid`, '0\n');
    writeFileSync(`${directory}/etc/crypttab`, randomSwap);
    const state = collectHost(directory);
    assert.deepEqual(state, { ...fixture(), crypttab: randomSwap });
    assert.deepEqual(hostFailures(state), []);
    assert.deepEqual(collectHost(directory), state);
    rmSync(`${directory}/proc/sys/kernel/core_pattern`);
    function missingSetting() { return collectHost(directory); }
    assert.throws(missingSetting, /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
