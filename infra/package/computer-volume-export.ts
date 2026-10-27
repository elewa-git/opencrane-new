import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { collectComputerVolumeInventory } from './computer-volume-inventory.ts';
import { captureBounds } from './event-backup.ts';
import { readBackupKey, readPrivateFile } from './event-restore.ts';

type InventoryArguments = Parameters<typeof collectComputerVolumeInventory>;
type Inventory = Awaited<ReturnType<typeof collectComputerVolumeInventory>>;
type Bounds = ReturnType<typeof captureBounds>;
type Options = InventoryArguments[2] & {
  backupKeyFile: string;
  destination: string;
  writersStopped: boolean;
};
type Home = Inventory['volumes'][number];
interface ExportInput {
  home: Home;
  stream: Readable;
  byteCount: number;
  sha256: string;
}
const maximumBytes = 64 * 1024 * 1024;
const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({ name: identifier, uid: identifier, resourceVersion: identifier });
const homeSchema = z.strictObject({ assistantId: identifier, computerId: identifier,
  generation: z.number().int().positive().safe(), sandbox: reference, home: reference,
  volume: reference });
const inventorySchema = z.strictObject({ kind: z.literal('computer-volume-inventory-only'),
  silo: identifier, attempt: identifier, eventArchiveSha256: digest,
  eventDescriptorSha256: digest, namespace: reference, volumes: z.array(homeSchema).max(1_000) });
const entrySchema = z.strictObject({ file: z.string().regex(/^home-[0-9]{4}\.enc$/),
  home: homeSchema, byteCount: z.number().int().nonnegative().max(maximumBytes), sha256: digest });
const descriptorSchema = z.strictObject({ version: z.literal(2),
  kind: z.literal('volume-export-only'), encryption: z.literal('aes-256-gcm'),
  binding: inventorySchema, exports: z.array(entrySchema).max(1_000) });
function fileIdentity(index: number) {
  return `home-${index.toString().padStart(4, '0')}.enc`;
}
function completeInventory(descriptor: z.infer<typeof descriptorSchema>) {
  if (descriptor.exports.length !== descriptor.binding.volumes.length) {
    return false;
  }
  const computers = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < descriptor.exports.length; index++) {
    const entry = descriptor.exports[index]!;
    const home = descriptor.binding.volumes[index];
    if (!isDeepStrictEqual(entry.home, home) || entry.file !== fileIdentity(index) ||
        computers.has(entry.home.computerId)) {
      return false;
    }
    computers.add(entry.home.computerId);
    totalBytes += entry.byteCount;
  }
  return totalBytes <= maximumBytes;
}
export const volumeExportDescriptorSchema = descriptorSchema.refine(completeInventory);

function refusal() {
  return new Error('Computer volume export refused');
}
function privateDirectory(path: string) {
  const metadata = lstatSync(path);
  if (path !== resolve(path) || realpathSync(path) !== path || !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw refusal();
  return metadata;
}
function writeBytes(output: number, bytes: Buffer, bounds: Bounds,
  archiveHash: ReturnType<typeof createHash>) {
  archiveHash.update(bytes);
  let offset = 0;
  while (offset < bytes.length) {
    bounds.check();
    const written = writeSync(output, bytes, offset);
    if (written === 0) throw refusal();
    offset += written;
  }
}
async function encrypt(input: ExportInput, binding: Inventory, file: string, destination: string,
  key: Buffer, bounds: Bounds, remainingBytes: number) {
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 0 ||
      input.byteCount > remainingBytes || !/^[a-f0-9]{64}$/.test(input.sha256)) throw refusal();
  const entry = { file, home: homeSchema.parse(input.home),
    byteCount: input.byteCount, sha256: input.sha256 };
  const output = openSync(join(destination, file), 'wx', 0o600);
  try {
    const archiveHash = createHash('sha256');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const associated = [2, 'volume-export-only', 'aes-256-gcm', binding, entry];
    cipher.setAAD(Buffer.from(JSON.stringify(associated)));
    writeBytes(output, nonce, bounds, archiveHash);
    const iterator = input.stream[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    let byteCount = 0;
    for (;;) {
      const next = await bounds.bounded(iterator.next());
      if (next.done) break;
      const bytes: unknown = next.value;
      if (!Buffer.isBuffer(bytes)) throw refusal();
      byteCount += bytes.length;
      if (byteCount > entry.byteCount || byteCount > remainingBytes) throw refusal();
      hash.update(bytes);
      writeBytes(output, cipher.update(bytes), bounds, archiveHash);
    }
    const sha256 = hash.digest('hex');
    if (byteCount !== entry.byteCount || sha256 !== entry.sha256) throw refusal();
    writeBytes(output, cipher.final(), bounds, archiveHash);
    writeBytes(output, cipher.getAuthTag(), bounds, archiveHash);
    bounds.check();
    fsyncSync(output);
    bounds.check();
    return { entry, archiveSha256: archiveHash.digest('hex') };
  } finally {
    closeSync(output);
  }
}

/** Use a trusted internal reader; metadata alone does not prove that a live PVC supplied bytes. */
export async function collectComputerVolumeExport(source: InventoryArguments[0],
  target: InventoryArguments[1], options: Options,
  readExport: (binding: Inventory, signal: AbortSignal, home: Home) => Promise<ExportInput>,
  readKubernetes?: InventoryArguments[3],
  archiveWritten?: (file: string, sha256: string) => void) {
  let key: Buffer | undefined;
  let bounds: Bounds | undefined;
  let owned: ReturnType<typeof privateDirectory> | undefined;
  let stream: Readable | undefined;
  const controller = new AbortController();
  function checkOutput() {
    const current = privateDirectory(options.destination);
    if (!owned || current.dev !== owned.dev || current.ino !== owned.ino) throw refusal();
  }
  function closeReader() {
    stream?.destroy();
  }
  try {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        options.writersStopped !== true) throw refusal();
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    signal.addEventListener('abort', closeReader, { once: true });
    bounds = captureBounds(source, { signal, timeoutMs });
    const activeBounds = bounds;
    key = readBackupKey(options.backupKeyFile);
    const material = key;
    privateDirectory(options.directory);
    privateDirectory(dirname(options.destination));
    if (options.destination !== resolve(options.destination)) throw refusal();
    bounds.check();
    mkdirSync(options.destination, { mode: 0o700 });
    owned = privateDirectory(options.destination);
    const exports: z.infer<typeof entrySchema>[] = [];
    const archiveHashes = new Map<string, string>();
    // Share the byte allowance across all homes; the bounds also cover the whole call.
    let totalBytes = 0;
    // Close a reader even if its open request finishes after the deadline.
    function accept(input: ExportInput) {
      stream = input.stream;
      // Observe close errors even when cancellation happens before iteration starts.
      stream.on('error', activeBounds.stop);
      try {
        activeBounds.check();
        return input;
      } catch {
        closeReader();
        throw refusal();
      }
    }
    async function capture(binding: Inventory) {
      for (const home of binding.volumes) {
        activeBounds.check();
        if (options.writersStopped !== true) {
          throw refusal();
        }
        const opening = readExport(structuredClone(binding), signal, structuredClone(home));
        const pending = opening.then(accept);
        const input = await activeBounds.bounded(pending);
        try {
          if (!isDeepStrictEqual(input.home, home)) {
            throw refusal();
          }
          checkOutput();
          const file = fileIdentity(exports.length);
          const content = await encrypt(input, binding, file, options.destination, material,
            activeBounds, maximumBytes - totalBytes);
          totalBytes += content.entry.byteCount;
          exports.push(content.entry);
          archiveHashes.set(file, content.archiveSha256);
          archiveWritten?.(file, content.archiveSha256);
        } finally {
          closeReader();
        }
      }
    }
    const inventoryOptions = { ...options, timeoutMs, signal };
    const binding = await collectComputerVolumeInventory(source, target, inventoryOptions,
      readKubernetes, capture);
    if (options.writersStopped !== true) throw refusal();
    const descriptor = { version: 2, kind: 'volume-export-only',
      encryption: 'aes-256-gcm', binding, exports };
    const result = volumeExportDescriptorSchema.parse(descriptor);
    checkOutput();
    // Compare saved bytes with the original encryption output before reporting success.
    for (const entry of exports) {
      bounds.check();
      const saved = readPrivateFile(join(options.destination, entry.file), entry.byteCount + 28);
      const hash = createHash('sha256');
      hash.update(saved);
      if (saved.length !== entry.byteCount + 28 ||
          hash.digest('hex') !== archiveHashes.get(entry.file)) throw refusal();
    }
    bounds.check();
    writeFileSync(join(options.destination, 'descriptor.partial'), JSON.stringify(result),
      { flag: 'wx', mode: 0o600, flush: true });
    bounds.check();
    renameSync(join(options.destination, 'descriptor.partial'),
      join(options.destination, 'descriptor.json'));
    bounds.check();
    return result;
  } catch {
    if (owned) {
      try {
        checkOutput();
        rmSync(options.destination, { recursive: true, force: true });
      } catch {
        // Withhold paths and preserve output whose ownership changed.
      }
    }
    throw refusal();
  } finally {
    controller.abort();
    closeReader();
    key?.fill(0);
    bounds?.dispose();
  }
}
