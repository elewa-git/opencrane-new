import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { scanPinnedHostedSbom } from '../src/hosted-vulnerabilities.ts';

const now = Date.parse('2026-11-07T12:00:00.000Z');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const database = Buffer.from('pinned database fixture');
const imageDigest = 'a'.repeat(64);
const artifact = { id: 'pkg-one', name: 'demo', version: '1.0.0', type: 'npm',
  locations: [{ path: '/app/demo' }] };
const sbom = Buffer.from(JSON.stringify({ descriptor: { name: 'syft', version: '1.54.0' },
  artifacts: [artifact], source: { type: 'oci-dir' } }));

function report(severity = 'Low') {
  return { matches: [{ artifact, vulnerability: { id: 'CVE-TEST', severity } }],
    source: { type: 'sbom-file' }, distro: {},
    descriptor: { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-07T10:00:00.000Z', schemaVersion: '6.0.0' } } };
}

async function fixture(change?: (state: {
  status: Record<string, unknown>; report: Record<string, unknown>;
  calls: string[] }) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-vulnerability-test-'));
  const databasePath = join(directory, 'database.tar.gz');
  await writeFile(databasePath, database);
  const binaryPath = resolve('.tools/grype');
  const state = { status: { valid: true, schemaVersion: '6.0.0',
    built: '2026-11-07T10:00:00.000Z' }, report: report(), calls: [] as string[] };
  change?.(state);
  async function run(_binary: string, args: string[]) {
    state.calls.push(args.join(' '));
    if (args[0] === 'db' && args[1] === 'import') {
      return { stdout: '' };
    }
    if (args[0] === 'db' && args[1] === 'status') {
      return { stdout: JSON.stringify(state.status) };
    }
    return { stdout: JSON.stringify(state.report) };
  }
  const settings = { binaryPath, databasePath, databaseDigest: digest(database) };
  const input = { sbom, sbomDigest: digest(sbom), imageDigest,
    platform: 'linux/amd64' as const, packageCount: 1 };
  try {
    const result = await scanPinnedHostedSbom(input, settings, run, () => now);
    return { result, state };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('records a dated digest-bound low-severity result from a fresh actual database', async () => {
  const { result, state } = await fixture();
  expect(result.verdict).toBe('pass');
  if (result.verdict !== 'pass') return;
  expect(result.evidence).toMatchObject({ imageDigest, platform: 'linux/amd64',
    sbomDigest: digest(sbom), databaseDigest: digest(database),
    databaseUpdatedAt: '2026-11-07T10:00:00.000Z', findingCount: 1 });
  expect(result.evidence.expiresAt).toBe('2026-11-08T10:00:00.000Z');
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
  const missing = await fixture(state => { state.status.valid = false; });
  const stale = await fixture(state => {
    state.status.built = '2026-11-06T10:00:00.000Z';
    state.report.descriptor = { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-06T10:00:00.000Z', schemaVersion: '6.0.0' } };
  });
  const changed = await fixture(state => {
    state.report.descriptor = { name: 'grype', version: '0.121.0', db: {
      built: '2026-11-07T11:00:00.000Z', schemaVersion: '6.0.0' } };
  });
  expect(missing.result.verdict).not.toBe('pass');
  expect(stale.result.verdict).not.toBe('pass');
  expect(changed.result.verdict).not.toBe('pass');
});

it('refuses ignored findings, partial coverage and truncated output', async () => {
  const ignored = await fixture(state => { state.report.ignoredMatches = [{}]; });
  const alert = await fixture(state => { state.report.alertsByPackage = [{}]; });
  const partial = await fixture(state => { state.report.matches = [{ vulnerability: {
    severity: 'Low' } }]; });
  const truncated = await fixture(state => { state.report = { truncated: true }; });
  for (const item of [ignored, alert, partial, truncated]) {
    expect(item.result.verdict).not.toBe('pass');
  }
});

it('refuses tool failure, wrong database digest and changed SBOM identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-vulnerability-refusal-'));
  const databasePath = join(directory, 'database.tar.gz');
  await writeFile(databasePath, database);
  const input = { sbom, sbomDigest: digest(sbom), imageDigest,
    platform: 'linux/amd64' as const, packageCount: 1 };
  const settings = { binaryPath: resolve('.tools/grype'), databasePath,
    databaseDigest: 'b'.repeat(64) };
  async function broken() { throw new Error('/private/report/bytes'); }
  try {
    const wrongDatabase = await scanPinnedHostedSbom(input, settings, broken, () => now);
    const changedSbom = await scanPinnedHostedSbom({ ...input,
      sbomDigest: 'c'.repeat(64) }, settings, broken, () => now);
    expect(wrongDatabase.verdict).not.toBe('pass');
    expect(changedSbom.verdict).not.toBe('pass');
    expect(JSON.stringify([wrongDatabase, changedSbom])).not.toContain('/private');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
