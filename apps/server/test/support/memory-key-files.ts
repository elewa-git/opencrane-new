import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { MemoryIdentity } from '@opencrane/events';

const original = await vi.importActual<typeof fs>('node:fs');

// Keep every key for this fact in memory, including the interrupted temporary file.
export function memoryKeyFiles(directory: string, identity: MemoryIdentity) {
  const paths = new Set<string>();
  const files = new Map<string, Buffer>();
  const descriptors = new Map<number, string>();
  let nextDescriptor = -1;
  let interruptedPath: string | undefined;
  let pendingPath = '';
  for (const revision of [1, 2, 3, 4]) {
    const fields = [identity.silo, identity.scopeId, identity.scopeKind, identity.ownerId,
      identity.memoryId, revision];
    const hash = createHash('sha256');
    hash.update(JSON.stringify(fields));
    const path = `${directory}/${hash.digest('hex')}`;
    paths.add(path);
    paths.add(`${path}-pending`);
    if (revision === 4) pendingPath = `${path}-pending`;
  }
  function exists(path: fs.PathLike) {
    if (paths.has(String(path))) return files.has(String(path));
    return original.existsSync(path);
  }
  function open(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) {
    const name = String(path);
    if (!paths.has(name)) return original.openSync(path, flags, mode);
    if (flags === 'wx') {
      if (files.has(name)) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
      files.set(name, Buffer.alloc(0));
      if (name === interruptedPath) {
        interruptedPath = undefined;
        throw new Error('Interrupted after temporary file creation');
      }
    }
    const descriptor = nextDescriptor--;
    descriptors.set(descriptor, name);
    return descriptor;
  }
  function write(...args: Parameters<typeof fs.writeFileSync>) {
    const [file, data] = args;
    const path = typeof file === 'number' ? descriptors.get(file) : undefined;
    if (path) {
      files.set(path, Buffer.from(data as Uint8Array));
      return;
    }
    original.writeFileSync(...args);
  }
  function read(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
    if (paths.has(String(path))) {
      const bytes = files.get(String(path));
      if (!bytes) throw Object.assign(new Error('File missing'), { code: 'ENOENT' });
      return bytes;
    }
    return Reflect.apply(original.readFileSync, original, [path, ...args]) as Buffer | string;
  }
  function link(source: fs.PathLike, destination: fs.PathLike) {
    if (!paths.has(String(source))) return original.linkSync(source, destination);
    if (files.has(String(destination))) {
      throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
    }
    files.set(String(destination), files.get(String(source))!);
  }
  function remove(...args: Parameters<typeof fs.rmSync>) {
    const path = String(args[0]);
    if (paths.has(path)) {
      files.delete(path);
      return;
    }
    original.rmSync(...args);
  }
  function sync(descriptor: number) {
    if (!descriptors.has(descriptor)) original.fsyncSync(descriptor);
  }
  function close(descriptor: number) {
    if (!descriptors.delete(descriptor)) original.closeSync(descriptor);
  }
  const spies = [
    vi.spyOn(fs, 'existsSync').mockImplementation(exists),
    vi.spyOn(fs, 'openSync').mockImplementation(open),
    vi.spyOn(fs, 'writeFileSync').mockImplementation(write),
    vi.spyOn(fs, 'readFileSync').mockImplementation(read as typeof fs.readFileSync),
    vi.spyOn(fs, 'linkSync').mockImplementation(link),
    vi.spyOn(fs, 'rmSync').mockImplementation(remove),
    vi.spyOn(fs, 'fsyncSync').mockImplementation(sync),
    vi.spyOn(fs, 'closeSync').mockImplementation(close),
  ];
  function interrupt() {
    interruptedPath = pendingPath;
  }
  function pending() {
    return files.has(pendingPath);
  }
  function restore() {
    for (const spy of spies) spy.mockRestore();
  }
  return { interrupt, pending, restore };
}
