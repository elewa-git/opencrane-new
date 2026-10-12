import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function openOwnedDirectory(path: string, owner: number): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  const information = fstatSync(descriptor);
  if (!information.isDirectory() || information.uid !== owner) {
    closeSync(descriptor);
    throw new Error('Unsafe display directory');
  }
  return descriptor;
}

export function prepareTemporaryDirectory(path = '/tmp'): void {
  const descriptor = openOwnedDirectory(path, 0);
  try {
    // Prevent other users replacing desktop files in the shared temporary volume.
    fchmodSync(descriptor, 0o1777);
  } finally {
    closeSync(descriptor);
  }
}

function isDisplayOneServer(processRoot: string, pid: number): boolean {
  const processDirectory = `${processRoot}/${pid}`;
  const processName = readFileSync(`${processDirectory}/comm`, 'utf8').trim();
  const commandLine = readFileSync(`${processDirectory}/cmdline`, 'utf8');
  const argumentsList = commandLine.split('\0');
  return processName === 'Xvnc' && argumentsList.includes(':1');
}

function hasLiveDisplayServer(contents: string, processRoot: string): boolean {
  const pid = Number(contents.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    return isDisplayOneServer(processRoot, pid);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function removeCheckedLock(path: string, processRoot: string, owner: number): void {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let descriptor: number;
  try {
    descriptor = openSync(path, flags);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== owner || opened.nlink !== 1 || (opened.mode & 0o022)) {
      throw new Error('Unsafe display lock');
    }
    if (hasLiveDisplayServer(readFileSync(descriptor, 'utf8'), processRoot)) return;
    const current = lstatSync(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error('Display lock changed before removal');
    }
    // The checked parent and sticky bit prevent an untrusted UID replacing this inode.
    // Run before Xvnc starts, so the trusted desktop user cannot be creating a new lock.
    unlinkSync(path);
  } finally {
    closeSync(descriptor);
  }
}

export function removeStaleDisplayLock(
  lockPath: string, processRoot = '/proc', owner = process.getuid!(),
): void {
  const parent = openOwnedDirectory(dirname(lockPath), process.getuid!());
  try {
    const information = fstatSync(parent);
    if ((information.mode & 0o022) && !(information.mode & 0o1000)) {
      throw new Error('Display lock parent needs the sticky bit');
    }
    removeCheckedLock(`/proc/self/fd/${parent}/${basename(lockPath)}`, processRoot, owner);
  } finally {
    closeSync(parent);
  }
}

export function prepareDisplaySocketDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o711 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  restrictDisplaySocketDirectory(path);
}

export function restrictDisplaySocketDirectory(path: string): void {
  const descriptor = openOwnedDirectory(path, process.getuid!());
  try {
    // Let other users connect to the socket without letting them create files here.
    fchmodSync(descriptor, 0o711);
  } finally {
    closeSync(descriptor);
  }
}
