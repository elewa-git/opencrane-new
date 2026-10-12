import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as display from '../src/display-lock.ts';

const scenario = process.argv[2];
const root = '/display-test';
const temporary = `${root}/tmp`;
const sockets = `${temporary}/.X11-unix`;
const lock = `${temporary}/.X1-lock`;
fs.mkdirSync(root);
fs.mkdirSync(temporary, { mode: 0o777 });
fs.chmodSync(temporary, 0o777);
const credentials = `${root}/credentials.json`;
fs.writeFileSync(credentials, 'private', { mode: 0o600 });
fs.chownSync(credentials, 1002, 1002);

function agent(source) {
  const args = ['--reuid=1001', '--regid=1001', '--clear-groups', '--',
    'node', '--input-type=module', '-e', source];
  return spawnSync('setpriv', args, { encoding: 'utf8' });
}

function protectTemporary() {
  // Run the real startup operation when present; the old code leaves this volume at 0777.
  display.prepareTemporaryDirectory?.(temporary);
}

if (scenario === 'socket-swap') {
  fs.mkdirSync(sockets, { mode: 0o711 });
  fs.chownSync(sockets, 1002, 1002);
  protectTemporary();
  const attack = agent(`import {renameSync,symlinkSync} from 'node:fs';
    renameSync('${sockets}', '${sockets}-old');
    symlinkSync('${credentials}', '${sockets}');`);
  process.setgroups([]);
  process.setgid(1002);
  process.setuid(1002);
  display.restrictDisplaySocketDirectory(sockets);
  assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
  assert.notEqual(attack.status, 0);
} else if (scenario === 'symlink-lock') {
  protectTemporary();
  assert.equal(agent(`import {symlinkSync} from 'node:fs';
    symlinkSync('${credentials}', '${lock}');`).status, 0);
  assert.throws(function rejectLink() { display.removeStaleDisplayLock(lock); });
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
} else if (scenario === 'foreign-lock') {
  protectTemporary();
  assert.equal(agent(`import {writeFileSync} from 'node:fs';
    writeFileSync('${lock}', 'bad pid');`).status, 0);
  assert.throws(function rejectOwner() { display.removeStaleDisplayLock(lock); });
  assert.equal(fs.statSync(lock).uid, 1001);
} else if (scenario === 'lock-replacement') {
  fs.writeFileSync(lock, 'invalid pid');
  protectTemporary();
  const originalUnlink = fs.default.unlinkSync;
  let attack;
  function replaceBeforeUnlink(path) {
    attack = agent(`import {renameSync,writeFileSync} from 'node:fs';
      renameSync('${lock}', '${lock}-old');
      writeFileSync('${lock}', 'replacement');`);
    originalUnlink(path);
  }
  fs.default.unlinkSync = replaceBeforeUnlink;
  syncBuiltinESMExports();
  display.removeStaleDisplayLock(lock);
  assert.ok(attack);
  assert.notEqual(attack.status, 0);
  assert.equal(fs.existsSync(`${lock}-old`), false);
} else {
  throw new Error('Unknown attack');
}
