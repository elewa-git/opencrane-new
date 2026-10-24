import fs from 'node:fs';
import { takeWorkerInput, type workerRequest } from './worker-request.ts';

type Entry = { path: string; descriptor: number; identity: fs.Stats };
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

function sameIdentity(first: fs.Stats, second: fs.Stats | undefined) {
  return second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

function checkedEntry(path: string, descriptor: number, before: fs.Stats): Entry {
  const identity = fs.fstatSync(descriptor);
  if (!sameIdentity(before, identity)) {
    fs.closeSync(descriptor);
    throw new Error();
  }
  return { path, descriptor, identity };
}

function checkParent(entry: Entry, privateParent: boolean) {
  const stat = entry.identity;
  const owner = process.geteuid!();
  if (!stat.isDirectory() || (stat.uid !== owner && stat.uid !== 0) || (stat.mode & 0o022)) {
    throw new Error();
  }
  if (privateParent && (stat.uid !== owner || (stat.mode & 0o077))) {
    throw new Error();
  }
}

function checkEntries(entries: Entry[]) {
  for (const entry of entries) {
    const current = fs.lstatSync(entry.path, { throwIfNoEntry: false });
    const opened = fs.fstatSync(entry.descriptor);
    if (opened.uid !== entry.identity.uid || opened.gid !== entry.identity.gid ||
        opened.mode !== entry.identity.mode) {
      throw new Error();
    }
    if (opened.isFile() && opened.nlink !== 1) {
      throw new Error();
    }
    if (!sameIdentity(entry.identity, current) || current?.isSymbolicLink()) {
      throw new Error();
    }
  }
}

function openParent(path: string, parents: Entry[]) {
  const parts = path.split('/');
  if (!path.startsWith('/') || parts.slice(1).some(unsafePart)) {
    throw new Error();
  }
  let current = '/';
  for (const part of parts) {
    if (part) {
      current = `/proc/self/fd/${parents.at(-1)!.descriptor}/${part}`;
    }
    const before = fs.lstatSync(current);
    const descriptor = fs.openSync(current, directoryFlags);
    const entry = checkedEntry(current, descriptor, before);
    parents.push(entry);
    checkParent(entry, false);
  }
  const parent = parents.at(-1)!;
  checkParent(parent, true);
  return parent;
}

function unsafePart(part: string) {
  return part === '' || part === '.' || part === '..';
}

function createDirectory(parent: Entry, name: string, owned: Entry[]) {
  const path = `/proc/self/fd/${parent.descriptor}/${name}`;
  fs.mkdirSync(path, { mode: 0o700 });
  const before = fs.lstatSync(path);
  const descriptor = fs.openSync(path, directoryFlags);
  const entry = checkedEntry(path, descriptor, before);
  owned.push(entry);
  checkParent(entry, true);
  return entry;
}

function createFile(parent: Entry, name: string, bytes: string, owned: Entry[]) {
  const path = `/proc/self/fd/${parent.descriptor}/${name}`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(path, flags, 0o600);
  const identity = fs.fstatSync(descriptor);
  const entry = { path, descriptor, identity };
  owned.push(entry);
  checkEntries(owned);
  if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.geteuid!()) {
    throw new Error();
  }
  fs.writeFileSync(descriptor, bytes, 'utf8');
  checkEntries(owned);
}

function closeEntries(entries: Entry[]) {
  for (const entry of entries.reverse()) {
    fs.closeSync(entry.descriptor);
  }
}

function removeOwned(owned: Entry[]) {
  let failed = false;
  // Keep descriptors open until all removals finish, so inode numbers cannot be reused.
  // Never recurse into a directory or follow a replacement link during cleanup.
  for (const entry of [...owned].reverse()) {
    try {
      const current = fs.lstatSync(entry.path, { throwIfNoEntry: false });
      if (!sameIdentity(entry.identity, current)) {
        continue;
      }
      if (entry.identity.isDirectory()) {
        fs.rmdirSync(entry.path);
      } else {
        fs.unlinkSync(entry.path);
      }
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new Error('worker_input_cleanup_refused');
  }
}

// Accept the supervisor's private parent, never a path or environment from a command.
// Prepare files only. A future launcher must still isolate its runtime and enforce limits.
export function prepareWorkerInput(plan: ReturnType<typeof workerRequest>, parentPath: string) {
  const parents: Entry[] = [];
  const owned: Entry[] = [];
  let closed = false;
  function cleanup() {
    if (closed) {
      return;
    }
    closed = true;
    try {
      removeOwned(owned);
    } finally {
      closeEntries(owned);
      closeEntries(parents);
    }
  }
  try {
    const input = takeWorkerInput(plan);
    const name = plan.identity.operationId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(name)) {
      throw new Error();
    }
    const parent = openParent(parentPath, parents);
    checkEntries(parents);
    const root = createDirectory(parent, name, owned);
    const work = createDirectory(root, 'operation', owned);
    for (const location of ['tmp', 'cache', 'config']) {
      createDirectory(root, location, owned);
      checkEntries(owned);
    }
    const variable = createDirectory(root, 'var', owned);
    createDirectory(variable, 'empty', owned);
    if (input.manifest !== undefined) {
      createFile(work, 'package.json', input.manifest, owned);
      createFile(work, 'package-lock.json', input.lockfile, owned);
    }
    checkEntries(parents);
    checkEntries(owned);
    const prepared = { cleanup };
    return Object.freeze(prepared);
  } catch {
    try {
      cleanup();
    } catch {
      throw new Error('worker_input_refused');
    }
    // Discard filesystem errors because their paths can contain private values.
    throw new Error('worker_input_refused');
  }
}
