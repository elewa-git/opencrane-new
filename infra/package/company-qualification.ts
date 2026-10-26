import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkFresh } from './fresh-twice.ts';
import { checkJourney } from './journey-check.ts';

export const companyConditions = {
  'participants': 'Two ordinary people, two groups with distinct facts, child-only ' +
    'invitee, admin, second silo.',
  'groups.list': 'Load actual group membership.',
  'groups.create': 'Create a flat group and grant access through membership.',
  'groups.search': 'Search groups.',
  'groups.detail': 'Show actual group members and access.',
  'groups.removal_review': 'Explain lost access before removal.',
  'groups.remove_member': 'Revoke new calls and affected sockets within two seconds.',
  'membership.refusals': 'Deny same-id cross-silo calls and unavailable or stale OpenFGA.',
  'ownership.transfer': 'Transfer authority, retain the old owner, then step down separately.',
  'ownership.last_owner_refused': 'Concurrent last-owner demotions leave an owner; ' +
    'safe leaver reassignment.',
  'direct_chat.exchange_and_no_agent': 'Direct human chat causes no AI effects.',
  'group_chat.exchange_and_no_agent': 'Group human chat causes no AI effects.',
  'chat.lifecycle': 'Send, reload, reconnect, paginate, close, archive, unread and ' +
    'participant changes.',
  'chat.refusals': 'Deny mode mutation, nonparticipant, closed and foreign requests.',
  'shared_assistant.created': 'Create and select the group assistant with its ' +
    'reviewed grants and payer.',
  'shared_assistant.private_chat': 'Two simultaneous requesters and follow-ups keep ' +
    'credentials, tokens and memory separate on one ' +
    'computer.',
  'child.creation': 'Crash at each boundary produces one child and activation; ' +
    'explicit assistant and payer.',
  'child.navigation': 'All starting, working, waiting, retrying, terminal, closed ' +
    'and restricted states; Back restores position at 390px.',
  'child.disclosure': 'Frozen audience, late child-only invite/full history, ' +
    'independent parent rights, purge removed viewers, deny ' +
    'guessed ids and late HTTP/socket replies; restricted ' +
    'summaries reveal no text, counts or assets.',
  'child.publish': 'Human-reviewed publication to immediate parent once on retry; ' +
    'deny closed/revoked parent and private assets.',
  'delegation.money': 'One root allowance and charge for concurrent children and ' +
    'retries; hold unknown usage and settle late charges once.',
  'delegation.refusals': 'Deny altered root, payer, requester, computer and scopes; ' +
    'Stop and exhaustion cancel descendants before dispatch, ' +
    'including old reservations.',
  'memory.tools': 'Remember, recall, correct, forget in every allowed scope; ' +
    'approval-free group writes; exact/partial search, ranking, ' +
    'bounds, empty results, preferences and pins.',
  'memory.refusals': 'Deny cross-person, assistant-notes, group and silo ' +
    'reads/writes/search/pins; ignore forged scope headers.',
  'memory.deletion': 'Correction races, multibyte pin/preference cap, stale context ' +
    'invalidation, forget after duplicate merge/dreaming, key-deletion ' +
    ' failure and restart; tombstones and dependent facts ' +
    'survive replay with model endpoints disabled.',
  'memory.no_disk': 'Native Codex canaries absent from persistent volumes, ' +
    'rollouts, compaction, SOUL/config, outbox, logs, temporary ' +
    'files and crash artefacts during execution, kill/resume and ' +
    'replay; attempt local file/shell/browser writes.',
  'memory.isolation': 'Personal/group canaries absent from another requester ' +
    'prompt, shared notes, instructions, summary and published ' +
    'output without authorised sharing.',
  'dreaming': 'Nightly clock boundary, one scope/date batch, capped spend, merge, ' +
    'contradictions, expiry and pinned facts; crash/lost reply and ' +
    'concurrent correction/forget never repeat effects or revive content.',
  'dreaming.refusals': 'Deny missing owner, grant, model, payer or price.',
  'onboarding': 'Sign-in/invite, survey reload/edit/restart, persona review, no-Agent ' +
    ' welcome, ordered completion, read-only/archive and read-only ' +
    'SSO fields.',
  'admin.refusals': 'Wrong/expired invite account, absent email service, role ' +
    'denial and safe removal.',
  'providers.key_save': 'Keys absent from browser storage, events and logs; verify ' +
    'skip and unknown-save reconciliation.',
  'providers.paid_model_answer': 'Confirm remaining shared 500-cent allowance, ' +
    'provider cap and authorised paid answer.',
  'routines': 'Daily/weekly firing, timezone/DST, two schedulers, restart, ' +
    'missed/overlapping occurrence; company identity observed upstream.',
  'routines.refusals': 'Deny revoked owner/company profile or budget; Ask only ' +
    'original owner, timeout stops and no silent personal-account ' +
    ' fallback.',
  'replay.zero_effects': 'Rebuild PostgreSQL/OpenFGA; compare facts/revisions, ' +
    'search, UI, audit and budgets with model endpoints ' +
    'disabled; no model/tool/routine dispatch.',
  'recovery': 'Replace computer Pod; recover only authorised context, no private ' +
    'session files; duplicate routine/delegation delivery adds no effect ' +
    'or spend.',
  'regressions.phase2': 'Retain full reload and Pod recovery journeys.',
  'regressions.phase3': 'Retain full Odoo rights/read/approved write, OAuth, policy ' +
    'refusals, paying-group hard stop and audited takeover.',
  'screens.accessibility': 'Compare every delivered screen/state at 1280/390, ' +
    'including loading, empty, error, unknown outcome, ' +
    'changed access and long content; keyboard, assistive ' +
    'technology and reduced motion.',
  'gates.inherited': 'Full live P5-11, P5-12 and P4-28 feature dependencies; ' +
    'restore retains deleted keys and never revives forgotten ' +
    'facts.',
};

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
  runs: z.array(z.object({ binding, outcomes: z.unknown() })).length(2) }),
  runs: z.array(z.object({ fresh: z.unknown(),
    artifacts: z.array(text).max(64) })).length(2) });
const artifactSchema = z.object({ kind: z.literal('company-journey'), binding,
  width: z.union([z.literal(1280), z.literal(390)]), date: z.iso.datetime(), command: text,
  assertions: z.array(z.object({ id: text, status: text, executed: z.boolean(),
    expected: text, observed: text,
    zero: z.record(text, z.number().int().nonnegative()).optional(),
  })).max(128) });
type Binding = z.infer<typeof binding>;
type Artifact = z.infer<typeof artifactSchema>;

function requireEvidence(valid: unknown): asserts valid {
  if (!valid) throw new Error('Evidence refused');
}

async function readJson(root: string, name: string, budget: { bytes: number }) {
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
    const value: unknown = JSON.parse(buffer.toString('utf8', 0, result.bytesRead));
    return value;
  } finally {
    await handle.close();
  }
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

function checkBindings(runs: z.infer<typeof inputSchema>['journey']['runs'],
  expected: { source: string; image: string }) {
  const earlier = runs[0]!.binding;
  for (const run of runs) {
    const current = run.binding;
    requireEvidence(current.source === expected.source && current.image === expected.image);
    requireEvidence(/^k3d-opencrane-target-[12]$/u.test(current.context));
    requireEvidence(current.context === earlier.context && current.namespace === earlier.namespace);
    checkJourney(run, current);
  }
  const later = runs[1]!.binding;
  for (const field of ['namespaceUid', 'releaseUid', 'installId', 'storeId'] as const) {
    requireEvidence(earlier[field] !== later[field]);
  }
  for (const field of ['pvcUids', 'pvUids'] as const) {
    for (const uid of later[field]) requireEvidence(!earlier[field].includes(uid));
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

function conditionStatus(artifact: Artifact | undefined, id: string) {
  if (!artifact) return 'NOT RUN';
  function matches(assertion: Artifact['assertions'][number]) { return assertion.id === id; }
  const rows = artifact.assertions.filter(matches);
  if (rows.length !== 1) return 'NOT RUN';
  const row = rows[0]!;
  if (row.status === 'FAIL') return 'FAIL';
  if (row.status !== 'PASS' || !row.executed) return 'NOT RUN';
  for (const field of zeroFields(id)) {
    if (row.zero?.[field] !== 0) return 'NOT RUN (missing counted zero effects)';
  }
  return 'PASS';
}

export async function checkCompanyQualification(root: string, value: unknown,
  expected: { source: string; image: string }) {
  const completed: string[] = [];
  const blockers: string[] = [];
  const input = inputSchema.safeParse(value);
  try {
    requireEvidence(input.success);
    checkBindings(input.data.journey.runs, expected);
  } catch {
    return { status: 'NOT RUN', complete: false, completed, blockers: ['Journey bindings refused'] };
  }
  const budget = { bytes: 0 };
  for (let index = 0; index < 2; index++) {
    const label = `install ${index + 1}`;
    const current = input.data.journey.runs[index]!.binding;
    const run = input.data.runs[index]!;
    try {
      const snapshot = fresh.parse(run.fresh);
      checkFreshBinding(snapshot, current, input.data.journey.runs[index - 1]?.binding);
    } catch {
      blockers.push(`${label}: fresh empty state NOT RUN`);
    }
    const artifacts = new Map<number, Artifact>();
    try {
      const directory = await realpath(root);
      for (const name of run.artifacts) {
        const value = await readJson(directory, name, budget);
        const artifact = artifactSchema.parse(value);
        requireEvidence(Date.parse(artifact.date) >= Date.parse(current.installedAt));
        requireEvidence(isDeepStrictEqual(artifact.binding, current));
        requireEvidence(!artifacts.has(artifact.width));
        artifacts.set(artifact.width, artifact);
      }
    } catch {
      blockers.push(`${label}: artefact refused`);
    }
    for (const width of [1280, 390]) {
      for (const id of Object.keys(companyConditions)) {
        const labelWithCondition = `${label} / ${width} / ${id}`;
        const status = conditionStatus(artifacts.get(width), id);
        if (status === 'PASS') completed.push(labelWithCondition);
        else blockers.push(`${labelWithCondition}: ${status}`);
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
