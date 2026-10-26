import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { collectComputerVolumeInventory } from './computer-volume-inventory.ts';
import { captureBounds } from './event-backup.ts';
import { readBackupKey } from './event-restore.ts';

type InventoryArguments = Parameters<typeof collectComputerVolumeInventory>;
type Inventory = Awaited<ReturnType<typeof collectComputerVolumeInventory>>;
type Bounds = ReturnType<typeof captureBounds>;
type Options = InventoryArguments[2] & {
  backupKeyFile: string;
  destination: string;
  writersStopped: boolean;
};
interface ExportInput {
  stream: Readable;
  byteCount: number;
  sha256: string;
}
const maximumBytes = 64 * 1024 * 1024;
function refusal() {
  return new Error('Computer volume export refused');
}
function privateDirectory(path: string) {
  const metadata = lstatSync(path);
  if (path !== resolve(path) || realpathSync(path) !== path || !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw refusal();
  return metadata;
}
function writeBytes(output: number, bytes: Buffer, bounds: Bounds) {
  let offset = 0;
  while (offset < bytes.length) {
    bounds.check();
    const written = writeSync(output, bytes, offset);
    if (written === 0) throw refusal();
    offset += written;
  }
}
async function encrypt(input: ExportInput, binding: Inventory, destination: string,
  key: Buffer, bounds: Bounds) {
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 0 ||
      input.byteCount > maximumBytes || !/^[a-f0-9]{64}$/.test(input.sha256)) throw refusal();
  const output = openSync(join(destination, 'home.enc'), 'wx', 0o600);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const associated = [binding, input.byteCount, input.sha256];
    cipher.setAAD(Buffer.from(JSON.stringify(associated)));
    writeBytes(output, nonce, bounds);
    const iterator = input.stream[Symbol.asyncIterator]();
    const hash = createHash('sha256');
    let byteCount = 0;
    for (;;) {
      const next = await bounds.bounded(iterator.next());
      if (next.done) break;
      const bytes: unknown = next.value;
      if (!Buffer.isBuffer(bytes)) throw refusal();
      byteCount += bytes.length;
      if (byteCount > input.byteCount || byteCount > maximumBytes) throw refusal();
      hash.update(bytes);
      writeBytes(output, cipher.update(bytes), bounds);
    }
    const sha256 = hash.digest('hex');
    if (byteCount !== input.byteCount || sha256 !== input.sha256) throw refusal();
    writeBytes(output, cipher.final(), bounds);
    writeBytes(output, cipher.getAuthTag(), bounds);
    bounds.check();
    fsyncSync(output);
    bounds.check();
    return { byteCount, sha256 };
  } finally {
    closeSync(output);
  }
}

/** Use a trusted internal reader; metadata alone does not prove that a live PVC supplied bytes. */
export async function collectComputerVolumeExport(source: InventoryArguments[0],
  target: InventoryArguments[1], options: Options,
  readExport: (binding: Inventory, signal: AbortSignal) => Promise<ExportInput>,
  readKubernetes?: InventoryArguments[3]) {
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
    let content: { byteCount: number; sha256: string } | undefined;
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
      if (binding.volumes.length !== 1) throw refusal();
      const pending = readExport(structuredClone(binding), signal).then(accept);
      const input = await activeBounds.bounded(pending);
      try {
        checkOutput();
        content = await encrypt(input, binding, options.destination, material, activeBounds);
      } finally {
        closeReader();
      }
    }
    const inventoryOptions = { ...options, timeoutMs, signal };
    const binding = await collectComputerVolumeInventory(source, target, inventoryOptions,
      readKubernetes, capture);
    if (!content || options.writersStopped !== true) throw refusal();
    const result = { version: 1, kind: 'volume-export-only' as const,
      encryption: 'aes-256-gcm', binding, ...content };
    checkOutput();
    bounds.check();
    writeFileSync(join(options.destination, 'descriptor.partial'), JSON.stringify(result),
      { flag: 'wx', mode: 0o600, flush: true });
    bounds.check();
    renameSync(join(options.destination, 'descriptor.partial'),
      join(options.destination, 'descriptor.json'));
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
