import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync,
  readSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { checkComputerVolumeBackup } from './computer-volume-check.ts';
import { checkMemoryRestore } from './memory-restore-check.ts';

type CheckArguments = Parameters<typeof checkComputerVolumeBackup>;
type Delivery = NonNullable<CheckArguments[3]>;
type Descriptor = Parameters<Delivery>[0];
type Binding = { silo: string; attempt: string; home: Descriptor['binding']['volumes'][number] };
type Target = Readonly<{ directory: string }>;
type Options = CheckArguments[1] & {
  stopped: boolean;
  effectsDisabled: boolean;
  memory: {
    source: CheckArguments[0];
    sourceDirectory: string;
    candidateDirectory: string;
  };
};
const targets = new WeakMap<Target, { binding: Binding; identity: bigint[]; used: boolean }>();
function refusal() {
  return new Error('Computer home restore refused; keep targets isolated');
}
function emptyIdentity(directory: string) {
  const info = lstatSync(directory, { bigint: true });
  if (directory !== resolve(directory) || realpathSync(directory) !== directory ||
      !info.isDirectory() || info.uid !== BigInt(process.getuid!()) ||
      (info.mode & 0o777n) !== 0o700n || readdirSync(directory).length !== 0) {
    throw refusal();
  }
  return [info.dev, info.ino, info.mtimeNs, info.ctimeNs, info.mode, info.uid];
}

/** Create a new empty fixture directory, separate from every existing source home. */
export function provisionComputerHomeTarget(binding: Binding): Target {
  try {
    const directory = mkdtempSync(join(tmpdir(), 'computer-home-target-'));
    const location = { directory };
    const target = Object.freeze(location);
    const saved = { binding: structuredClone(binding), identity: emptyIdentity(directory),
      used: false };
    targets.set(target, saved);
    return target;
  } catch {
    throw refusal();
  }
}

function claim(registered: Target[]) {
  const unique = new Set(registered);
  if (unique.size !== registered.length) {
    throw refusal();
  }
  for (const target of registered) {
    const saved = targets.get(target);
    if (!saved || saved.used) {
      throw refusal();
    }
  }
  // Consume the entire attempt before awaiting anything. A failure cannot enable a later writer.
  for (const target of registered) {
    targets.get(target)!.used = true;
  }
}
function checkTargets(registered: Target[], descriptor: Descriptor) {
  if (registered.length !== descriptor.exports.length) throw refusal();
  for (let index = 0; index < registered.length; index++) {
    const target = registered[index]!;
    const saved = targets.get(target)!;
    const binding = { silo: descriptor.binding.silo, attempt: descriptor.binding.attempt,
      home: descriptor.exports[index]!.home };
    if (!isDeepStrictEqual(saved.binding, binding) ||
        !isDeepStrictEqual(saved.identity, emptyIdentity(target.directory))) {
      throw refusal();
    }
  }
}

async function writeImage(target: Target, bytes: Buffer, bounds: CheckArguments[2]) {
  bounds.check();
  if (!isDeepStrictEqual(targets.get(target)!.identity, emptyIdentity(target.directory))) {
    throw refusal();
  }
  const output = openSync(join(target.directory, 'home-image'), 'wx+', 0o600);
  const readback = Buffer.alloc(Math.min(bytes.length, 32 * 1024));
  try {
    for (let offset = 0; offset < bytes.length;) {
      bounds.check();
      const length = Math.min(32 * 1024, bytes.length - offset);
      const written = writeSync(output, bytes, offset, length, offset);
      if (written !== length) {
        throw refusal();
      }
      offset += written;
      // Let cancellation arrive before reading back or starting another home.
      await bounds.bounded(setImmediate());
    }
    bounds.check();
    fsyncSync(output);
    for (let offset = 0; offset < bytes.length;) {
      bounds.check();
      const length = Math.min(readback.length, bytes.length - offset);
      const count = readSync(output, readback, 0, length, offset);
      const observed = readback.subarray(0, length);
      const expected = bytes.subarray(offset, offset + length);
      if (count !== length || !observed.equals(expected)) {
        throw refusal();
      }
      offset += count;
      await bounds.bounded(setImmediate());
    }
    bounds.check();
  } finally {
    readback.fill(0);
    closeSync(output);
  }
}

/** Restore opaque bytes only. Never mount, extract, replay, reopen or clean up an uncertain target. */
export async function restoreComputerVolumeBackup(source: CheckArguments[0], options: Options,
  requested: Target[], bounds: CheckArguments[2]) {
  const registered = [...requested];
  try {
    bounds.check();
    if (options.stopped !== true || options.effectsDisabled !== true) {
      throw refusal();
    }
    claim(registered);
    let byteCount = 0;
    async function deliver(descriptor: Descriptor, plaintext: Buffer[], recheck: () => Promise<void>) {
      checkTargets(registered, descriptor);
      const memoryOptions = { silo: options.silo, stopped: options.stopped,
        sourceDirectory: options.memory.sourceDirectory,
        candidateDirectory: options.memory.candidateDirectory };
      await bounds.bounded(checkMemoryRestore(options.memory.source, source, memoryOptions));
      await recheck();
      checkTargets(registered, descriptor);
      bounds.check();
      for (let index = 0; index < registered.length; index++) {
        await writeImage(registered[index]!, plaintext[index]!, bounds);
        byteCount += plaintext[index]!.length;
      }
    }
    await checkComputerVolumeBackup(source, options, bounds, deliver);
    return { kind: 'home-image-bytes-only' as const, homes: registered.length, byteCount };
  } catch {
    // Preserve saved bytes and consume every target, even when completion is uncertain.
    throw refusal();
  }
}
