import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  prepareDisplaySocketDirectory, removeStaleDisplayLock, restrictDisplaySocketDirectory,
} from '../src/display-lock.ts';

const temporaryDirectories: string[] = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'computer-display-lock-'));
  temporaryDirectories.push(root);
  const procRoot = join(root, 'proc');
  const lockPath = join(root, '.X1-lock');
  mkdirSync(procRoot);
  writeFileSync(lockPath, '4321\n', { mode: 0o600 });
  return { root, procRoot, lockPath };
}

function cleanFixtures() {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

afterEach(cleanFixtures);

function removesLockWhenProcessIsGone() {
  const fixture = makeFixture();

  removeStaleDisplayLock(fixture.lockPath, fixture.procRoot);

  expect(existsSync(fixture.lockPath)).toBe(false);
}

function removesLockWhenProcessIdIsReused() {
  const fixture = makeFixture();
  const reusedPid = join(fixture.procRoot, '4321');
  mkdirSync(reusedPid);
  writeFileSync(join(reusedPid, 'comm'), 'node\n');
  writeFileSync(join(reusedPid, 'cmdline'), 'node\0/app/src/bridge.ts\0');

  removeStaleDisplayLock(fixture.lockPath, fixture.procRoot);

  expect(existsSync(fixture.lockPath)).toBe(false);
}

function keepsLockForLiveDisplayServer() {
  const fixture = makeFixture();
  const xvncPid = join(fixture.procRoot, '4321');
  mkdirSync(xvncPid);
  writeFileSync(join(xvncPid, 'comm'), 'Xvnc\n');
  writeFileSync(join(xvncPid, 'cmdline'), 'Xvnc\0:1\0');

  removeStaleDisplayLock(fixture.lockPath, fixture.procRoot);

  expect(readFileSync(fixture.lockPath, 'utf8')).toBe('4321\n');
}

function keepsDisplaySocketsOpenWithoutAllowingNewFiles() {
  const fixture = makeFixture();
  const socketDirectory = join(fixture.root, '.X11-unix');

  prepareDisplaySocketDirectory(socketDirectory);

  expect(statSync(socketDirectory).mode & 0o777).toBe(0o711);
}

function restoresSocketDirectoryPermissionsAfterXvncStarts() {
  const fixture = makeFixture();
  const socketDirectory = join(fixture.root, '.X11-unix');
  mkdirSync(socketDirectory);
  chmodSync(socketDirectory, 0o1777);

  restrictDisplaySocketDirectory(socketDirectory);

  expect(statSync(socketDirectory).mode & 0o777).toBe(0o711);
}

it('removes an Xvnc lock when its old process is gone', removesLockWhenProcessIsGone);
it('removes an Xvnc lock when its process id now belongs to another program',
  removesLockWhenProcessIdIsReused);
it('keeps the lock while Xvnc still owns display 1', keepsLockForLiveDisplayServer);
it('keeps display sockets reachable without allowing new files',
  keepsDisplaySocketsOpenWithoutAllowingNewFiles);
it('restores socket directory permissions after Xvnc starts',
  restoresSocketDirectoryPermissionsAfterXvncStarts);
