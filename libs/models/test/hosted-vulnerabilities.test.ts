import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hostedImageCheckedSchema } from '@opencrane/events';
import { beforeAll, expect, it } from 'vitest';
import { inspectHostedVulnerabilities, scanPinnedHostedSbom }
  from '../src/hosted-vulnerabilities.ts';

const now = Date.parse('2026-11-07T12:00:00.000Z');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const database = Buffer.from('pinned database fixture');
const imageDigest = 'a'.repeat(64);
const layerDigest = `sha256:${'d'.repeat(64)}`;
function fetchGrype() {
  execFileSync('sh', ['scripts/fetch-hosted-grype.sh']);
}
beforeAll(fetchGrype, 120_000);
const artifact = { id: 'pkg-one', name: 'demo', version: '1.0.0', type: 'npm',
  locations: [{ path: '/app/demo', layerID: layerDigest }] };
const imageMetadata = { manifestDigest: `sha256:${imageDigest}`, os: 'linux',
  architecture: 'amd64', layers: [{ digest: layerDigest }] };
const sbom = Buffer.from(JSON.stringify({ descriptor: { name: 'syft', version: '1.54.0' },
  artifacts: [artifact], source: { type: 'image', metadata: imageMetadata } }));

function report(severity = 'Low') {
  return { matches: [{ artifact, vulnerability: { id: 'CVE-TEST', severity } }],
    source: { type: 'image', target: imageMetadata }, distro: {},
    descriptor: { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-07T10:00:00.000Z', schemaVersion: '6.0.0' } } };
}

type Reply = 'normal' | 'lost' | 'duplicate' | 'error' | 'timeout';
type State = { status: Record<string, unknown>; report: Record<string, unknown>;
  calls: string[]; reply: Reply };

async function fixture(change?: (state: State) => void,
  inputChange?: { platform?: 'linux/amd64' | 'linux/arm64'; sbomDigest?: string;
    packageCount?: number }, databasePin?: string,
  duringScan?: (input: Parameters<typeof scanPinnedHostedSbom>[0],
    settings: Parameters<typeof scanPinnedHostedSbom>[1]) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-vulnerability-test-'));
  const databasePath = join(directory, 'database.tar.gz');
  await writeFile(databasePath, database);
  const binaryPath = resolve('.tools/grype');
  const state: State = { status: { valid: true, schemaVersion: '6.0.0',
    built: '2026-11-07T10:00:00.000Z' }, report: report(), calls: [] as string[],
    reply: 'normal' };
  change?.(state);
  function run(_binary: string, args: string[]) {
    state.calls.push(args.join(' '));
    if (args[0] === 'db' && args[1] === 'import') {
      return Promise.resolve({ stdout: '' });
    }
    if (args[0] === 'db' && args[1] === 'status') {
      return Promise.resolve({ stdout: JSON.stringify(state.status) });
    }
    if (state.reply === 'error') return Promise.reject(new Error('/private/report/bytes'));
    if (state.reply === 'timeout') return Promise.reject(new Error('scan timed out'));
    if (state.reply === 'lost') return Promise.resolve({ stdout: '' });
    const source = state.report['source'];
    if (typeof source === 'object' && source !== null &&
        'type' in source && source.type === 'sbom-file') {
      state.report['source'] = { type: 'sbom-file', target: args[0]!.slice(5) };
    }
    duringScan?.(input, settings);
    const output = JSON.stringify(state.report);
    if (state.reply === 'duplicate') return Promise.resolve({ stdout: output + output });
    return Promise.resolve({ stdout: output });
  }
  const settings = { binaryPath, databasePath,
    databaseDigest: databasePin ?? digest(database) };
  const input = { sbom, sbomDigest: inputChange?.sbomDigest ?? digest(sbom), imageDigest,
    platform: inputChange?.platform ?? 'linux/amd64',
    packageCount: inputChange?.packageCount ?? 1 };
  try {
    const result = await scanPinnedHostedSbom(input, settings, run, () => now);
    return { result, state };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('records a dated digest-bound low-severity result from a fresh actual database', async () => {
  const { result, state } = await fixture();
  const repeated = await fixture();
  expect(result.verdict).toBe('pass');
  expect(repeated.result.verdict).toBe('pass');
  if (result.verdict !== 'pass') return;
  expect(result.evidence).toMatchObject({ imageDigest, platform: 'linux/amd64',
    sbomDigest: digest(sbom), databaseDigest: digest(database),
    databaseUpdatedAt: '2026-11-07T10:00:00.000Z', findingCount: 1 });
  expect(result.evidence?.['expiresAt']).toBe('2026-11-08T10:00:00.000Z');
  expect(repeated.result.evidence?.['sbomDigest']).toBe(result.evidence?.['sbomDigest']);
  expect(repeated.result.evidence?.['databaseDigest']).toBe(result.evidence?.['databaseDigest']);
  expect(repeated.result.evidence?.['databaseUpdatedAt'])
    .toBe(result.evidence?.['databaseUpdatedAt']);
  expect(hostedImageCheckedSchema.shape.checks.shape.vulnerability.safeParse(result.receipt).success)
    .toBe(true);
  expect(state.calls).toHaveLength(3);
  expect(state.calls[2]).toContain('sbom:');
});

for (const severity of ['High', 'Critical', 'Unknown', 'Unexpected']) {
  it(`refuses ${severity} severity`, async () => {
    const { result } = await fixture(state => {
      state.report = report(severity);
    });
    expect(result.verdict).not.toBe('pass');
  });
}

it('refuses missing, stale and falsely repackaged database facts', async () => {
  const missing = await fixture(state => { state.status['valid'] = false; });
  const stale = await fixture(state => {
    state.status['built'] = '2026-11-06T10:00:00.000Z';
    state.report['descriptor'] = { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-06T10:00:00.000Z', schemaVersion: '6.0.0' } };
  });
  const changed = await fixture(state => {
    state.report['descriptor'] = { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-07T11:00:00.000Z', schemaVersion: '6.0.0' } };
  });
  expect(missing.result.verdict).not.toBe('pass');
  expect(stale.result.verdict).not.toBe('pass');
  expect(changed.result.verdict).not.toBe('pass');
});

it('refuses ignored findings, partial coverage and truncated output', async () => {
  const ignored = await fixture(state => { state.report['ignoredMatches'] = [{}]; });
  const alert = await fixture(state => { state.report['alertsByPackage'] = [{}]; });
  const partial = await fixture(state => { state.report['matches'] = [{ vulnerability: {
    severity: 'Low' } }]; });
  const truncated = await fixture(state => { state.report = { truncated: true }; });
  for (const item of [ignored, alert, partial, truncated]) {
    expect(item.result.verdict).not.toBe('pass');
  }
});

it('refuses a duplicate or lost scan reply, tool error and timeout', async () => {
  for (const reply of ['duplicate', 'lost', 'error', 'timeout'] as const) {
    const checked = await fixture(state => { state.reply = reply; });
    expect(checked.result.verdict).not.toBe('pass');
    expect(JSON.stringify(checked.result)).not.toContain('/private');
  }
});

it('refuses changed platform, SBOM hash and package coverage', async () => {
  const platform = await fixture(undefined, { platform: 'linux/arm64' });
  const altered = await fixture(undefined, { sbomDigest: 'c'.repeat(64) });
  const partial = await fixture(undefined, { packageCount: 2 });
  expect(platform.result.verdict).not.toBe('pass');
  expect(altered.result.verdict).not.toBe('pass');
  expect(partial.result.verdict).not.toBe('pass');
});

it('refuses a database archive with the wrong approved digest', async () => {
  const checked = await fixture(undefined, undefined, 'b'.repeat(64));
  expect(checked.result.verdict).not.toBe('pass');
  expect(checked.state.calls).toHaveLength(0);
});

it('refuses evidence when the caller changes checked digests during the scan', async () => {
  function oldSource(state: State) {
    state.report['source'] = { type: 'sbom-file' };
  }
  function changeDigests(input: Parameters<typeof scanPinnedHostedSbom>[0],
    settings: Parameters<typeof scanPinnedHostedSbom>[1]) {
    input.imageDigest = 'b'.repeat(64);
    input.sbomDigest = 'c'.repeat(64);
    settings.databaseDigest = 'd'.repeat(64);
  }
  const checked = await fixture(oldSource, undefined, undefined, changeDigests);
  expect(checked.result).toEqual({ verdict: 'unavailable',
    reasonCode: 'vulnerability_scan_unavailable' });
});

it('refuses a report naming another image', async () => {
  function changeSource(state: State) {
    state.report['source'] = { type: 'image', target: {
      ...imageMetadata, manifestDigest: `sha256:${'b'.repeat(64)}` } };
  }
  const checked = await fixture(changeSource);
  expect(checked.result.verdict).not.toBe('pass');
});

it('does not reach the scanner when publisher verification fails', async () => {
  function unexpectedRead() {
    return Promise.reject(new Error('Registry must not be read'));
  }
  const request = { repository: 'registry.example/tool', imageDigest,
    platform: 'linux/amd64' };
  const options = { cosign: resolve('.tools/cosign'), syft: resolve('.tools/syft'),
    osiPath: resolve('.tools/osi.json'), reviewPath: '/missing/review',
    binaryPath: resolve('.tools/grype'), databasePath: '/missing/database',
    databaseDigest: digest(database) };
  const result = await inspectHostedVulnerabilities(request, {}, unexpectedRead, options,
    () => now);
  expect(result).toEqual({ verdict: 'fail', reasonCode: 'signature_refused' });
});
