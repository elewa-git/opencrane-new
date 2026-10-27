import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkComputerVolumeBackup } from './computer-volume-check.ts';
import { collectComputerVolumeExport } from './computer-volume-export.ts';
import { captureBounds, collectEventBackup, descriptorSchema } from './event-backup.ts';
import { checkHistory, readPrivateFile } from './event-restore.ts';
import { collectObjectBackup } from './object-backup.ts';
import { checkObjectBackup } from './object-restore.ts';

type ExportArguments = Parameters<typeof collectComputerVolumeExport>;
type Options = Omit<ExportArguments[2], 'directory'>;
const maximumBytes = 64 * 1024 * 1024;
function refusal() {
  return new Error('Backup capture refused; completion unknown; keep targets isolated');
}
function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}
function description(directory: string) {
  return readPrivateFile(join(directory, 'descriptor.json'), 1024 * 1024);
}
function fingerprints(directory: string) {
  const result: Record<string, string> = {};
  const names = readdirSync(directory);
  for (const name of names) {
    const bytes = readPrivateFile(join(directory, name), maximumBytes + 28);
    result[name] = digest(bytes);
  }
  return result;
}
function createDestination(destination: string) {
  const parent = dirname(destination);
  const metadata = lstatSync(parent);
  if (destination !== resolve(destination) || realpathSync(parent) !== parent ||
      !metadata.isDirectory() || metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700) throw refusal();
  mkdirSync(destination, { mode: 0o700 });
}

/** Require trusted readers and an already checked namespace. Keep all writers stopped. */
export async function collectBackupCapture(source: ExportArguments[0],
  objectTarget: ExportArguments[1], homeTarget: ExportArguments[1],
  objects: Parameters<typeof collectObjectBackup>[2], options: Options,
  readExport: ExportArguments[3], readKubernetes: ExportArguments[4]) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  let bounds: ReturnType<typeof captureBounds> | undefined;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        options.disposable !== true || !objectTarget.info?.server_id ||
        !homeTarget.info?.server_id ||
        objectTarget.info.server_id === homeTarget.info.server_id ||
        objectTarget.info.server_id === source.info?.server_id ||
        homeTarget.info.server_id === source.info?.server_id) throw refusal();
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const timing = { timeoutMs, signal };
    bounds = captureBounds(source, timing);
    const activeBounds = bounds;
    function remaining() {
      activeBounds.check();
      const left = Math.floor(deadline - performance.now());
      if (options.writersStopped !== true || left < 1) throw refusal();
      return left;
    }
    remaining();
    createDestination(options.destination);
    const eventDirectory = join(options.destination, 'events');
    const objectDirectory = join(options.destination, 'objects');
    const homeDirectory = join(options.destination, 'homes');
    // Freeze identities for this attempt, but keep checking the caller's writer state.
    const settings = { ...options, directory: eventDirectory, signal };
    const eventOptions = { ...settings, destination: eventDirectory, timeoutMs: remaining() };
    await collectEventBackup(source, eventOptions);
    const eventBytes = description(eventDirectory);
    const events = descriptorSchema.parse(JSON.parse(eventBytes.toString('utf8')));
    const eventFiles = { 'events.snapshot': events.sha256, 'descriptor.json': digest(eventBytes) };
    const objectFiles: Record<string, string> = {};
    const homeFiles: Record<string, string> = {};
    // Keep hashes from encryption; reading them after a later copy could accept changed bytes.
    function objectWritten(file: string, sha256: string) {
      objectFiles[file] = sha256;
    }
    function homeWritten(file: string, sha256: string) {
      homeFiles[file] = sha256;
    }
    const objectOptions = { ...settings, destination: objectDirectory, timeoutMs: remaining() };
    await collectObjectBackup(source, objectTarget, objects, objectOptions, objectWritten);
    const objectBytes = description(objectDirectory);
    const objectSchema = z.object({ kind: z.literal('event-referenced-objects-only'),
      silo: z.literal(settings.silo), attempt: z.literal(settings.attempt),
      eventArchiveSha256: z.literal(events.sha256),
      eventDescriptorSha256: z.literal(digest(eventBytes)), objects: z.array(z.unknown()),
    });
    const objectProof = objectSchema.parse(JSON.parse(objectBytes.toString('utf8')));
    objectFiles['descriptor.json'] = digest(objectBytes);
    const homeOptions = { ...settings, destination: homeDirectory, timeoutMs: remaining(),
      get writersStopped() { return options.writersStopped; } };
    const homes = await collectComputerVolumeExport(source, homeTarget, homeOptions,
      readExport, readKubernetes, homeWritten);
    const homeBytes = description(homeDirectory);
    homeFiles['descriptor.json'] = digest(homeBytes);
    const objectCheckOptions = { ...settings, directory: objectDirectory, eventDirectory,
      targetSilo: settings.silo, stopped: true, exclusive: true, timeoutMs: remaining() };
    await checkObjectBackup(source, objectCheckOptions);
    const homeCheckOptions = { ...settings, eventDirectory, volumeDirectory: homeDirectory };
    remaining();
    await checkComputerVolumeBackup(source, homeCheckOptions, activeBounds);
    await checkHistory(activeBounds, events, maximumBytes);
    if (events.silo !== settings.silo || events.attempt !== settings.attempt ||
        homes.binding.silo !== settings.silo || homes.binding.attempt !== settings.attempt ||
        homes.binding.eventArchiveSha256 !== events.sha256 ||
        homes.binding.eventDescriptorSha256 !== digest(eventBytes) ||
        !isDeepStrictEqual(eventFiles, fingerprints(eventDirectory)) ||
        !isDeepStrictEqual(objectFiles, fingerprints(objectDirectory)) ||
        !isDeepStrictEqual(homeFiles, fingerprints(homeDirectory))) throw refusal();
    remaining();
    // Return component evidence only. Do not publish a complete-system manifest or resume work.
    return { kind: 'capture-components-only' as const, silo: settings.silo, attempt: settings.attempt,
      eventArchiveSha256: events.sha256, eventDescriptorSha256: digest(eventBytes),
      events: { kind: events.kind, count: events.eventCount },
      objects: { kind: objectProof.kind, count: objectProof.objects.length,
        descriptorSha256: digest(objectBytes) },
      homes: { kind: homes.kind, count: homes.exports.length, descriptorSha256: digest(homeBytes) } };
  } catch {
    // Never erase or resend to a target: a lost reply may hide a completed restore.
    throw refusal();
  } finally {
    controller.abort();
    bounds?.dispose();
  }
}
