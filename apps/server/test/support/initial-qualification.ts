import * as fs from 'node:fs';
import * as processes from 'node:child_process';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { z } from 'zod';
import { collectDeployment } from '../../../../scripts/private-memory-qualification/deployment.ts';

const targetPath = '/etc/opencrane/private-memory-qualification.json';
const resultPath = '/etc/opencrane/private-memory-qualification-result.json';

// Simulate only the deployment's filesystem and Docker boundary. Run the real collector.
export async function initialQualificationFixture() {
  const files = new Map<string, string>();
  const descriptors = new Map<number, string>();
  const containerId = 'c'.repeat(64);
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  const sourceSha = 'a'.repeat(40);
  let host = 'fixture-host';
  function unchanged() {
    return Promise.resolve();
  }
  let observation = unchanged;
  const created = new Date(Date.now() - 3000).toISOString();
  const started = new Date(Date.now() - 2000).toISOString();
  let streamCreated = new Date(Date.now() - 1000).toISOString();
  const target = { containerId, siloId: 'test' };
  files.set(targetPath, JSON.stringify(target));
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  const originalStat = fs.fstatSync;
  const originalClose = fs.closeSync;
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  function open(...args: Parameters<typeof fs.openSync>) {
    const path = String(args[0]);
    if (!path.startsWith('/etc/opencrane/')) return originalOpen(...args);
    if (!files.has(path)) throw new Error('Missing deployment file');
    const descriptor = 100_000 + descriptors.size;
    descriptors.set(descriptor, path);
    return descriptor;
  }
  function read(...args: Parameters<typeof fs.readFileSync>) {
    const path = descriptors.get(Number(args[0]));
    if (!path) return originalRead(...args);
    return files.get(path)!;
  }
  function stat(...args: Parameters<typeof fs.fstatSync>) {
    const path = descriptors.get(args[0]);
    if (!path) return originalStat(...args);
    const metadata = { uid: 0, mode: 0o100600, size: Buffer.byteLength(files.get(path)!) };
    const copy = fs.statSync(import.meta.filename);
    return Object.assign(copy, metadata);
  }
  function close(descriptor: number) {
    if (!descriptors.has(descriptor)) originalClose(descriptor);
  }
  function write(...args: Parameters<typeof fs.writeFileSync>) {
    const path = String(args[0]);
    if (!path.startsWith('/etc/opencrane/')) return originalWrite(...args);
    files.set(path, z.string().parse(args[1]));
  }
  function rename(from: fs.PathLike, to: fs.PathLike) {
    if (!String(from).startsWith('/etc/opencrane/')) return originalRename(from, to);
    files.set(String(to), files.get(String(from))!);
    files.delete(String(from));
  }
  function docker(_file: unknown, args: unknown) {
    const command = z.array(z.string()).parse(args);
    if (command[2] === 'info') return JSON.stringify(host);
    if (command[2] === 'image') {
      return JSON.stringify([{ Id: imageDigest,
        Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]);
    }
    return JSON.stringify([{ Id: containerId, Image: imageDigest, Created: created,
      RestartCount: 0, State: { Running: true, StartedAt: started },
      HostConfig: { ReadonlyRootfs: true }, Mounts: [], Config: { Env: ['SILO_ID=test'] } }]);
  }
  function spawn(_file: string, args: readonly string[] = []) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new processes.ChildProcess(), { stdin, stdout, stderr });
    function input(buffer: Buffer) {
      async function reply() {
        const command = z.array(z.string()).parse(JSON.parse(args.at(-1)!));
        let result: unknown = { created: streamCreated, eventCount: 0, lastSequence: 0 };
        if (command.includes('--eval')) {
          await observation();
        } else {
          const raw = z.string().parse(JSON.parse(buffer.toString('utf8')));
          const request = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
          result = { ...request, result: 'PASS', complete: true, observedAt: Date.now() };
        }
        stdout.emit('data', Buffer.from(JSON.stringify(result)));
        child.emit('close', 0);
      }
      function failed() {
        child.emit('close', 1);
      }
      function respond() {
        void reply().catch(failed);
      }
      queueMicrotask(respond);
    }
    stdin.on('data', input);
    return child;
  }
  vi.spyOn(fs, 'openSync').mockImplementation(open);
  vi.spyOn(fs, 'readFileSync').mockImplementation(read);
  vi.spyOn(fs, 'fstatSync').mockImplementation(stat);
  vi.spyOn(fs, 'closeSync').mockImplementation(close);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(write);
  vi.spyOn(fs, 'renameSync').mockImplementation(rename);
  vi.spyOn(processes, 'execFileSync').mockImplementation(docker);
  vi.spyOn(processes, 'spawn').mockImplementation(spawn);
  const result = await collectDeployment();
  function replace(value: unknown) {
    files.set(resultPath, JSON.stringify(value));
  }
  function changeHost() {
    host = 'replacement-host';
  }
  function changeInstallation() {
    streamCreated = new Date().toISOString();
  }
  function remove() {
    files.delete(resultPath);
  }
  function observe(callback: () => Promise<void>) {
    observation = callback;
  }
  return { result, replace, changeHost, changeInstallation, remove, observe };
}
