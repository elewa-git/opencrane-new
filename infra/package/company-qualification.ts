import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkFresh } from './fresh-twice.ts';
import { checkJourney } from './journey-check.ts';

import { companyConditions, companyRequirements } from './company-conditions.ts';

export { companyConditions } from './company-conditions.ts';

const text = z.string().min(1).max(4096);
const strings = z.array(text).min(1).max(128);
const binding = z.object({ source: z.string().regex(/^[a-f0-9]{40}$/u),
  image: z.string().regex(/@sha256:[a-f0-9]{64}$/u), context: text, namespace: text,
  namespaceUid: text, releaseUid: text, installId: text, installedAt: z.iso.datetime(),
  pvcUids: strings, pvUids: strings, storeId: text, origin: text });
const dated = z.object({ uid: text, createdAt: z.iso.datetime() });
const fresh = z.object({ kind: z.literal('fresh-install'), state: z.object({
  installId: text, startedAt: z.iso.datetime(), installedAt: z.iso.datetime(),
  previousPvcUids: z.array(text), pvClaims: z.array(text),
  pvcs: z.array(dated).min(1).max(128), pvs: z.array(dated).min(1).max(128),
  events: z.array(z.object({ createdAt: z.iso.datetime() })).max(4096), storeId: text,
  memberIds: z.array(text).max(128),
  siloEvents: z.array(z.object({ type: text, time: z.iso.datetime() })).max(4096),
  rowCounts: z.record(text, z.number().int().nonnegative()),
}) });
const inputSchema = z.object({ journey: z.object({ status: z.literal('PARTIAL'),
  runs: z.array(z.unknown()).length(2) }),
  runs: z.array(z.object({ fresh: z.unknown(),
    artifacts: z.array(text).max(64) })).length(2) });
const artifactSchema = z.object({ kind: z.literal('company-journey'), binding,
  width: z.union([z.literal(1280), z.literal(390)]), date: z.iso.datetime(), command: text,
  assertions: z.array(z.object({ id: text, status: text, executed: z.boolean(),
    expected: text, observed: text,
    zero: z.record(text, z.number().int().nonnegative()).optional(),
    results: z.array(z.object({ requirement: text, evidence: text })).max(512).optional(),
  })).max(128) });
const resultSchema = z.object({ id: text, requirement: text, status: text,
  executed: z.boolean(), expected: text, observed: text,
  zero: z.record(text, z.number().int().nonnegative()).optional(), links: strings });
const proofSchema = z.object({ kind: z.literal('company-results'), binding,
  width: z.union([z.literal(1280), z.literal(390)]), date: z.iso.datetime(), command: text,
  results: z.array(resultSchema).max(2048) });
const journeyRunSchema = z.object({ binding, outcomes: z.unknown() });
type Proof = z.infer<typeof proofSchema>;
type JourneyRun = z.infer<typeof journeyRunSchema>;
type EvidenceFiles = { root: string; budget: { bytes: number };
  proofs: Map<string, Proof | null>; links: Set<string> };
type Binding = z.infer<typeof binding>;
type Artifact = z.infer<typeof artifactSchema>;

function requireEvidence(valid: unknown): asserts valid {
  if (!valid) throw new Error('Evidence refused');
}

async function readEvidenceFile(root: string, name: string, budget: { bytes: number }) {
  requireEvidence(!isAbsolute(name) && !name.includes('\\'));
  const parts = name.split('/');
  let path = root;
  for (const part of parts) {
    requireEvidence(part && part !== '.' && part !== '..');
    path = join(path, part);
    requireEvidence(!(await lstat(path)).isSymbolicLink());
  }
  const actual = await realpath(path);
  requireEvidence(relative(root, actual) === name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    requireEvidence(before.isFile() && before.size <= 1_048_576);
    budget.bytes += before.size;
    requireEvidence(budget.bytes <= 8_388_608);
    const buffer = Buffer.alloc(before.size + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    requireEvidence(result.bytesRead === before.size && after.size === before.size);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson(root: string, name: string, budget: { bytes: number }) {
  const buffer = await readEvidenceFile(root, name, budget);
  const value: unknown = JSON.parse(buffer.toString('utf8'));
  return value;
}

function checkFreshBinding(value: z.infer<typeof fresh>, current: Binding, previous?: Binding) {
  const state = value.state;
  checkFresh({ ...state, previousInstallId: previous?.installId,
    previousPvcUids: previous?.pvcUids ?? [], previousPvUids: previous?.pvUids ?? [],
    previousStoreId: previous?.storeId });
  function uid(item: { uid: string }) { return item.uid; }
  requireEvidence(state.installId === current.installId && state.storeId === current.storeId &&
    state.installedAt === current.installedAt &&
    isDeepStrictEqual(state.pvcs.map(uid), current.pvcUids) &&
    isDeepStrictEqual(state.pvs.map(uid), current.pvUids));
}

function checkInstallBinding(value: unknown, expected: { source: string; image: string },
  label: string, blockers: string[]): JourneyRun | undefined {
  const parsed = journeyRunSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[1];
      let message = `${label}: journey binding refused`;
      if (issue.path[0] === 'binding' && typeof field === 'string' && field in binding.shape) {
        message = `${label}: journey binding ${field} refused`;
      }
      blockers.push(message);
    }
    return undefined;
  }
  const current = parsed.data.binding;
  const mismatches: string[] = [];
  if (current.source !== expected.source) mismatches.push('source');
  if (current.image !== expected.image) mismatches.push('image');
  if (!/^k3d-opencrane-target-[12]$/u.test(current.context)) mismatches.push('context');
  const slot = current.context.slice(-1);
  if (current.namespace !== `opencrane-package-${slot}`) mismatches.push('namespace');
  if (current.origin !== `http://127.0.0.1:25${slot}06`) mismatches.push('origin');
  for (const field of mismatches) blockers.push(`${label}: journey binding ${field} refused`);
  if (mismatches.length > 0) return undefined;
  try {
    checkJourney(parsed.data, current);
  } catch {
    blockers.push(`${label}: journey outcomes refused`);
    return undefined;
  }
  return parsed.data;
}

function checkSharedBindings(runs: unknown[], blockers: string[]) {
  const earlierRun = journeyRunSchema.safeParse(runs[0]);
  const laterRun = journeyRunSchema.safeParse(runs[1]);
  if (!earlierRun.success || !laterRun.success) return;
  const earlier = earlierRun.data.binding;
  const later = laterRun.data.binding;
  for (const field of ['context', 'namespace'] as const) {
    if (earlier[field] !== later[field]) blockers.push(`shared: mismatched ${field} refused`);
  }
  for (const field of ['namespaceUid', 'releaseUid', 'installId', 'storeId'] as const) {
    if (earlier[field] === later[field]) blockers.push(`shared: reused ${field} refused`);
  }
  for (const field of ['pvcUids', 'pvUids'] as const) {
    for (const uid of later[field]) {
      if (earlier[field].includes(uid)) {
        blockers.push(`shared: reused ${field} refused`);
        break;
      }
    }
  }
}

function zeroFields(id: string): string[] {
  if (id === 'direct_chat.exchange_and_no_agent' ||
    id === 'group_chat.exchange_and_no_agent') {
    return ['model', 'tool', 'wake', 'approval', 'reservation', 'turn'];
  }
  if (id === 'memory.deletion' || id === 'replay.zero_effects' || id === 'recovery') {
    return ['model', 'tool', 'routine'];
  }
  if (id === 'memory.no_disk') return ['persistentCanary'];
  if (id === 'memory.isolation') return ['foreignCanary'];
  if (id === 'memory.tools') return ['groupWriteApproval'];
  if (id === 'ownership.last_owner_refused') return ['upstream'];
  if (id.endsWith('.refusals') || id === 'child.publish' || id === 'child.disclosure') {
    return ['upstream'];
  }
  return [];
}

function recordedStatus(row: { status: string; executed: boolean;
  zero?: Record<string, number> | undefined }, id: string) {
  if (row.status === 'FAIL') return 'FAIL';
  if (row.status !== 'PASS' || !row.executed) return 'NOT RUN';
  for (const field of zeroFields(id)) {
    if (row.zero?.[field] !== 0) return 'NOT RUN (missing counted zero effects)';
  }
  return 'PASS';
}

async function readProof(files: EvidenceFiles, name: string, artifact: Artifact) {
  let proof = files.proofs.get(name);
  if (!files.proofs.has(name)) {
    // Remember a refused file so repeated references cannot spend the other install's byte budget.
    files.proofs.set(name, null);
    const value = await readJson(files.root, name, files.budget);
    proof = proofSchema.parse(value);
    files.proofs.set(name, proof);
  }
  requireEvidence(proof);
  requireEvidence(isDeepStrictEqual(proof.binding, artifact.binding));
  requireEvidence(proof.width === artifact.width);
  requireEvidence(Date.parse(proof.date) >= Date.parse(artifact.binding.installedAt));
  return proof;
}

async function checkResult(files: EvidenceFiles, artifact: Artifact, id: string,
  requirement: string, references: NonNullable<Artifact['assertions'][number]['results']>) {
  function matchesReference(reference: typeof references[number]) {
    return reference.requirement === requirement;
  }
  const matching = references.filter(matchesReference);
  if (matching.length !== 1) return 'NOT RUN';
  try {
    const proof = await readProof(files, matching[0]!.evidence, artifact);
    function matchesResult(result: Proof['results'][number]) {
      return result.id === id && result.requirement === requirement;
    }
    const results = proof.results.filter(matchesResult);
    if (results.length !== 1) return 'NOT RUN';
    const result = results[0]!;
    const status = recordedStatus(result, id);
    if (status !== 'PASS') return status;
    for (const link of result.links) {
      if (files.links.has(link)) continue;
      const buffer = await readEvidenceFile(files.root, link, files.budget);
      requireEvidence(buffer.length > 0);
      files.links.add(link);
    }
    return 'PASS';
  } catch {
    return 'NOT RUN';
  }
}

async function checkCondition(files: EvidenceFiles, artifact: Artifact | undefined,
  id: string, label: string, blockers: string[]) {
  if (!artifact) {
    blockers.push(`${label}: NOT RUN`);
    return;
  }
  function matches(assertion: Artifact['assertions'][number]) { return assertion.id === id; }
  const rows = artifact.assertions.filter(matches);
  if (rows.length !== 1) {
    blockers.push(`${label}: NOT RUN`);
    return;
  }
  const row = rows[0]!;
  const status = recordedStatus(row, id);
  if (status !== 'PASS') {
    blockers.push(`${label}: ${status}`);
    return;
  }
  for (const requirement of companyRequirements[id]!) {
    const status = await checkResult(files, artifact, id, requirement, row.results ?? []);
    if (status !== 'PASS') blockers.push(`${label} / ${requirement}: ${status}`);
  }
}

async function readArtifacts(files: EvidenceFiles, names: string[], current: Binding,
  label: string, blockers: string[]) {
  const artifacts = new Map<number, Artifact>();
  try {
    files.root = await realpath(files.root);
    for (const name of names) {
      const value = await readJson(files.root, name, files.budget);
      const artifact = artifactSchema.parse(value);
      requireEvidence(Date.parse(artifact.date) >= Date.parse(current.installedAt));
      requireEvidence(isDeepStrictEqual(artifact.binding, current));
      requireEvidence(!artifacts.has(artifact.width));
      artifacts.set(artifact.width, artifact);
    }
  } catch {
    blockers.push(`${label}: artefact refused`);
  }
  return artifacts;
}

export async function checkCompanyQualification(root: string, value: unknown,
  expected: { source: string; image: string }) {
  const completed: string[] = [];
  const blockers: string[] = [];
  const input = inputSchema.safeParse(value);
  if (!input.success) {
    return { status: 'NOT RUN', complete: false, completed, blockers: ['Journey input refused'] };
  }
  const journeys: (JourneyRun | undefined)[] = [];
  for (let index = 0; index < 2; index++) {
    const label = `install ${index + 1}`;
    journeys.push(checkInstallBinding(input.data.journey.runs[index], expected, label, blockers));
  }
  checkSharedBindings(input.data.journey.runs, blockers);
  const budget = { bytes: 0 };
  for (let index = 0; index < 2; index++) {
    const label = `install ${index + 1}`;
    const current = journeys[index]?.binding;
    const run = input.data.runs[index]!;
    let acceptedFresh = false;
    if (current) {
      try {
        const snapshot = fresh.parse(run.fresh);
        checkFreshBinding(snapshot, current, journeys[index - 1]?.binding);
        acceptedFresh = true;
      } catch {
        blockers.push(`${label}: fresh empty state NOT RUN`);
      }
    }
    const files: EvidenceFiles = { root, budget, proofs: new Map(), links: new Set() };
    let artifacts = new Map<number, Artifact>();
    // Require an accepted binding and fresh state before counting this install's results.
    if (current && acceptedFresh) {
      artifacts = await readArtifacts(files, run.artifacts, current, label, blockers);
    }
    for (const width of [1280, 390]) {
      for (const id of Object.keys(companyConditions)) {
        const labelWithCondition = `${label} / ${width} / ${id}`;
        const previousBlockerCount = blockers.length;
        await checkCondition(files, artifacts.get(width), id, labelWithCondition, blockers);
        if (blockers.length === previousBlockerCount) completed.push(labelWithCondition);
      }
    }
  }
  // Report source-check results only. Live qualification remains a separate recorded journey.
  let status = 'NOT RUN';
  if (completed.length > 0) status = 'PARTIAL';
  return { status, complete: blockers.length === 0, completed, blockers };
}

async function main() {
  try {
    requireEvidence(process.argv.length === 5);
    const filename = resolve(process.argv[2]!);
    const root = await realpath(dirname(filename));
    const value = await readJson(root, basename(filename), { bytes: 0 });
    const expected = { source: process.argv[3]!, image: process.argv[4]! };
    const report = await checkCompanyQualification(root, value, expected);
    console.log(JSON.stringify(report));
    if (!report.complete) process.exitCode = 1;
  } catch {
    console.error('NOT RUN company evidence refused');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
