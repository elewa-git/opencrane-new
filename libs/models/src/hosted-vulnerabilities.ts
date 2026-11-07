import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { inspectHostedLicences } from './hosted-licences.ts';

const execute = promisify(execFile);
const pinnedBinaryDigest = 'bd511334178bc3002eb9eb58880f89e01e35f7fed7cfbe671171127a8afa3596';
const day = 86_400_000;
const sha = /^[a-f0-9]{64}$/u;
const refused = { verdict: 'unavailable', reasonCode: 'vulnerability_scan_unavailable' } as const;

type Input = { sbom: Buffer; sbomDigest: string; imageDigest: string;
  platform: 'linux/amd64' | 'linux/arm64'; packageCount: number };
type Settings = { binaryPath: string; databasePath: string; databaseDigest: string };
type Run = (binary: string, arguments_: string[], options: {
  cwd: string; env: Record<string, string>; timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string }>;
type Object = Record<string, unknown>;
const objectSchema = z.record(z.string(), z.unknown());
const artifactSchema = z.object({ id: z.string().min(1), name: z.string().min(1),
  version: z.string().min(1), type: z.string().min(1),
  locations: z.array(z.object({ layerID: z.string() })).min(1) });
const sourceSchema = z.object({ type: z.literal('image'), metadata: z.object({
  manifestDigest: z.string(), os: z.literal('linux'),
  architecture: z.enum(['amd64', 'arm64']),
  layers: z.array(z.object({ digest: z.string() })).min(1).max(64),
}) });
const reportSchema = z.object({
  matches: z.array(z.unknown()),
  ignoredMatches: z.array(z.unknown()).optional(),
  alertsByPackage: z.array(z.unknown()).optional(),
  source: z.object({ type: z.literal('sbom-file'), target: z.string() }),
  descriptor: z.object({ name: z.literal('grype'), version: z.literal('0.121.0'),
    db: z.object({ built: z.string(), schemaVersion: z.string() }) }),
});

function hash(bytes: Buffer) {
  const hasher = createHash('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function record(value: unknown): Object {
  return objectSchema.parse(value);
}

function validDate(value: unknown, now: number) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)) {
    throw new Error();
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now || now - time >= day) throw new Error();
  return time;
}

function packagesIn(input: Input) {
  const { sbom, packageCount, imageDigest, platform } = input;
  const document = record(JSON.parse(sbom.toString('utf8')));
  const descriptor = record(document['descriptor']);
  if (descriptor['name'] !== 'syft' || descriptor['version'] !== '1.54.0') throw new Error();
  const source = sourceSchema.parse(document['source']);
  if (source.metadata.manifestDigest !== `sha256:${imageDigest}` ||
      `${source.metadata.os}/${source.metadata.architecture}` !== platform) throw new Error();
  const layerDigests = new Set<string>();
  for (const layer of source.metadata.layers) layerDigests.add(layer.digest);
  const artifacts = z.array(artifactSchema).min(1).max(50_000).parse(document['artifacts']);
  if (artifacts.length !== packageCount) throw new Error();
  const identifiers = new Set<string>();
  for (const artifact of artifacts) {
    if (identifiers.has(artifact.id)) throw new Error();
    for (const location of artifact.locations) {
      if (!layerDigests.has(location.layerID)) throw new Error();
    }
    identifiers.add(artifact.id);
  }
  return identifiers;
}

function findingSeverity(value: unknown, identifiers: Set<string>) {
  const finding = record(value);
  const artifact = record(finding['artifact']);
  const vulnerability = record(finding['vulnerability']);
  if (typeof artifact['id'] !== 'string' || !identifiers.has(artifact['id']) ||
      typeof vulnerability['id'] !== 'string' || !vulnerability['id']) throw new Error();
  if (vulnerability['severity'] === 'High' || vulnerability['severity'] === 'Critical') return true;
  if (!['Negligible', 'Low', 'Medium'].includes(String(vulnerability['severity']))) throw new Error();
  return false;
}

function inspectReport(bytes: string, status: Object, sbomPath: string,
  identifiers: Set<string>) {
  const report = reportSchema.parse(JSON.parse(bytes));
  if (report.descriptor.db.built !== status['built'] ||
      report.descriptor.db.schemaVersion !== status['schemaVersion'] ||
      report.source.target !== sbomPath || report.ignoredMatches?.length ||
      report.alertsByPackage?.length) throw new Error();
  let blocked = false;
  for (const value of report.matches) {
    if (findingSeverity(value, identifiers)) blocked = true;
  }
  return { blocked, findingCount: report.matches.length };
}

function validateInput(input: Input, settings: Settings) {
  if (!sha.test(input.imageDigest) || !sha.test(input.sbomDigest) ||
      hash(input.sbom) !== input.sbomDigest || !sha.test(settings.databaseDigest) ||
      !['linux/amd64', 'linux/arm64'].includes(input.platform) ||
      input.sbom.length > 16 * 1024 * 1024) throw new Error();
  return packagesIn(input);
}

async function loadPinnedAssets(settings: Settings) {
  const binary = await readFile(settings.binaryPath);
  if (hash(binary) !== pinnedBinaryDigest) throw new Error();
  const archiveStats = await stat(settings.databasePath);
  if (!archiveStats.isFile() || archiveStats.size > 512 * 1024 * 1024) throw new Error();
  const archive = await readFile(settings.databasePath);
  if (hash(archive) !== settings.databaseDigest) throw new Error();
  return { binary, archive };
}

async function stage(directory: string, binary: Buffer, archive: Buffer, sbom: Buffer) {
  const binaryPath = join(directory, 'grype');
  const archivePath = join(directory, 'database.tar.gz');
  const sbomPath = join(directory, 'sbom.json');
  const configPath = join(directory, 'grype.yaml');
  // Execute the checked copy so a later change to the supplied path cannot replace it.
  await writeFile(binaryPath, binary, { mode: 0o700 });
  await writeFile(archivePath, archive, { mode: 0o600 });
  await writeFile(sbomPath, sbom, { mode: 0o600 });
  await writeFile(configPath, '{}', { mode: 0o600 });
  return { binaryPath, archivePath, sbomPath, configPath };
}

function scannerOptions(directory: string) {
  const env = { HOME: directory, TMPDIR: directory, XDG_CONFIG_HOME: directory,
    PATH: '/usr/bin:/bin', GRYPE_DB_CACHE_DIR: join(directory, 'db'),
    GRYPE_DB_AUTO_UPDATE: 'false', GRYPE_CHECK_FOR_APP_UPDATE: 'false',
    GRYPE_DB_VALIDATE_AGE: 'true', GRYPE_DB_MAX_ALLOWED_BUILT_AGE: '24h' };
  return { cwd: directory, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 };
}

function databaseStatus(output: string, now: number) {
  const status = record(JSON.parse(output));
  const databaseTime = validDate(status['built'], now);
  if (status['valid'] !== true || typeof status['schemaVersion'] !== 'string' ||
      !status['schemaVersion']) throw new Error();
  return { status, databaseTime };
}

export async function scanPinnedHostedSbom(input: Input, settings: Settings,
  run: Run = execute, clock: () => number = Date.now) {
  let directory: string | undefined;
  let outcome: { verdict: string; reasonCode?: string; evidence?: Object;
    receipt?: Object };
  try {
    const startedAt = clock();
    const identifiers = validateInput(input, settings);
    const assets = await loadPinnedAssets(settings);
    directory = await mkdtemp(join(tmpdir(), 'hosted-vulnerability-'));
    const paths = await stage(directory, assets.binary, assets.archive, input.sbom);
    const options = scannerOptions(directory);
    await run(paths.binaryPath,
      ['db', 'import', paths.archivePath, '--config', paths.configPath], options);
    const checked = await run(paths.binaryPath,
      ['db', 'status', '-o', 'json', '--config', paths.configPath], options);
    const checkedAt = clock();
    const { status, databaseTime } = databaseStatus(checked.stdout, checkedAt);
    if (checkedAt < startedAt) throw new Error();
    const scanned = await run(paths.binaryPath,
      [`sbom:${paths.sbomPath}`, '-o', 'json', '--config', paths.configPath], options);
    const finishedAt = clock();
    validDate(status['built'], finishedAt);
    if (finishedAt < checkedAt || finishedAt - startedAt > 180_000) throw new Error();
    const result = inspectReport(scanned.stdout, status, paths.sbomPath, identifiers);
    const evidence = { imageDigest: input.imageDigest, platform: input.platform,
      sbomDigest: input.sbomDigest, databaseDigest: settings.databaseDigest,
      databaseUpdatedAt: new Date(databaseTime).toISOString(),
      engineVersion: '0.121.0', checkedAt: new Date(finishedAt).toISOString(),
      expiresAt: new Date(databaseTime + day).toISOString(),
      reportDigest: hash(Buffer.from(scanned.stdout)), findingCount: result.findingCount,
      packageCount: input.packageCount };
    const receiptFields = { checkedAt: evidence.checkedAt, expiresAt: evidence.expiresAt,
      engineVersion: evidence.engineVersion, databaseDigest: evidence.databaseDigest,
      databaseUpdatedAt: evidence.databaseUpdatedAt, reportDigest: evidence.reportDigest };
    if (result.blocked) {
      const receipt = { ...receiptFields, verdict: 'fail',
        reasonCodes: ['vulnerability_refused'] };
      outcome = { verdict: 'fail', reasonCode: 'vulnerability_refused', evidence, receipt };
    } else {
      const receipt = { ...receiptFields, verdict: 'pass' };
      outcome = { verdict: 'pass', evidence, receipt };
    }
  } catch {
    // Discard scanner output and paths at this boundary; they may contain private package data.
    outcome = refused;
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        outcome = refused;
      }
    }
  }
  return outcome;
}

type InspectOptions = Parameters<typeof inspectHostedLicences>[3] & Settings;
type RegistryRead = Parameters<typeof inspectHostedLicences>[2];

export async function inspectHostedVulnerabilities(request: unknown, trust: unknown,
  read: RegistryRead, options: InspectOptions, clock: () => number = Date.now) {
  async function checkSbom(sbom: Buffer, evidence: {
    imageDigest: string; platform: string; sbomDigest: string; packageCount: number;
  }) {
    if (evidence.platform !== 'linux/amd64' && evidence.platform !== 'linux/arm64') {
      return refused;
    }
    const input: Input = { sbom, sbomDigest: evidence.sbomDigest,
      imageDigest: evidence.imageDigest, platform: evidence.platform,
      packageCount: evidence.packageCount };
    return scanPinnedHostedSbom(input, options, execute, clock);
  }
  try {
    return await inspectHostedLicences(request, trust, read, options, checkSbom);
  } catch {
    return refused;
  }
}
