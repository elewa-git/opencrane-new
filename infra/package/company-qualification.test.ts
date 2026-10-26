import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCompanyQualification, companyConditions } from './company-qualification.ts';

const source = 'a'.repeat(40);
const image = `local/server@sha256:${'b'.repeat(64)}`;
const expected = { source, image };

function fixture() {
  function run(index: number) {
    const binding = { source, image, context: 'k3d-opencrane-target-1',
      namespace: 'opencrane-package-1', namespaceUid: `namespace-${index}`,
      releaseUid: `release-${index}`, installId: `install-${index}`,
      installedAt: '2026-10-26T12:00:00.000Z', pvcUids: [`pvc-${index}`],
      pvUids: [`pv-${index}`], storeId: `store-${index}`, origin: 'http://127.0.0.1:25106' };
    const state = { installId: binding.installId, startedAt: binding.installedAt,
      installedAt: binding.installedAt, previousPvcUids: [], pvClaims: [],
      pvcs: [{ uid: binding.pvcUids[0]!, createdAt: binding.installedAt }],
      pvs: [{ uid: binding.pvUids[0]!, createdAt: binding.installedAt }],
      events: [], storeId: binding.storeId, memberIds: ['jente-rosseel'], siloEvents: [],
      rowCounts: { conversations: 0, conversation_files: 0, memory_facts: 0,
        memory_changes: 0, memory_dependencies: 0, memory_maintenance_runs: 0,
        memory_maintenance_bindings: 0 } };
    const outcomes = [1280, 390].map(outcome);
    return { binding, outcomes, state };
  }
  function outcome(width: number) {
    return { width, authenticated: true, subject: 'owner', chat: true, historyRefused: true };
  }
  const runs = [run(1), run(2)];
  const journey = { status: 'PARTIAL', runs, notRun: ['full P4-28 (P5-13)'] };
  return { journey, runs: runs.map(evidenceRun) };
}

function evidenceRun(run: ReturnType<typeof fixture>['journey']['runs'][number]) {
  return { fresh: { kind: 'fresh-install', state: run.state }, artifacts: [] as string[] };
}

async function prepared() {
  const root = await mkdtemp(join(tmpdir(), 'company-check-'));
  const input = fixture();
  for (let index = 0; index < 2; index++) {
    for (const width of [1280, 390]) {
      function assertion(id: string) {
        return { id, status: 'PASS', executed: true, expected: 'Expected result',
          observed: 'Observed result', zero: { model: 0, tool: 0, routine: 0,
            wake: 0, approval: 0, reservation: 0, upstream: 0 } };
      }
      const assertions = Object.keys(companyConditions).map(assertion);
      const artifact = { kind: 'company-journey', binding: input.journey.runs[index]!.binding,
        width, date: '2026-10-26T12:01:00.000Z', command: 'synthetic test only', assertions };
      const name = `${index}-${width}.json`;
      await writeFile(join(root, name), JSON.stringify(artifact));
      input.runs[index]!.artifacts.push(name);
    }
  }
  return { root, input };
}

async function editsArtifact(root: string, edit: (artifact: Record<string, unknown>) => void) {
  const path = join(root, '0-1280.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(artifact);
  await writeFile(path, JSON.stringify(artifact));
}

test('complete synthetic evidence checks logic without issuing a qualification PASS', async function () {
  const { root, input } = await prepared();
  try {
    const report = await checkCompanyQualification(root, input, expected);
    assert.equal(report.complete, true);
    assert.equal(report.status, 'PARTIAL');
    assert.deepEqual(report.blockers, []);
    assert.equal(report.completed.length, Object.keys(companyConditions).length * 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const fault of ['installId', 'pvcUids', 'pvUids', 'storeId', 'namespaceUid', 'releaseUid',
  'restored', 'source', 'image', 'width', 'stage-a', 'stage-b', 'skip', 'zero', 'foreign',
  'escape', 'symlink', 'oversize', 'count'] as const) {
  test(`refuses full acceptance: ${fault}`, async function () {
    const { root, input } = await prepared();
    try {
      const first = input.journey.runs[0]!;
      const second = input.journey.runs[1]!;
      if (fault in first.binding) {
        if (fault === 'source' || fault === 'image') first.binding[fault] = 'wrong';
        else Object.assign(second.binding, { [fault]: first.binding[fault] });
      }
      if (fault === 'restored') input.runs[0]!.fresh.state.rowCounts.memory_changes = 1;
      if (fault === 'width') input.runs[0]!.artifacts.pop();
      if (fault === 'stage-a' || fault === 'stage-b') Object.assign(input.journey, { runs: [] });
      if (fault === 'escape') input.runs[0]!.artifacts = ['../private.json'];
      if (fault === 'symlink') {
        await symlink(join(root, '0-1280.json'), join(root, 'linked.json'));
        input.runs[0]!.artifacts = ['linked.json'];
      }
      if (fault === 'oversize') await writeFile(join(root, '0-1280.json'), 'x'.repeat(1_048_577));
      if (fault === 'count') input.runs[0]!.artifacts = Array<string>(65).fill('0-1280.json');
      if (fault === 'foreign') input.runs[0]!.artifacts = ['1-1280.json'];
      if (fault === 'skip' || fault === 'zero') {
        function edit(artifact: Record<string, unknown>) {
          const assertions = artifact['assertions'] as Array<Record<string, unknown>>;
          for (const assertion of assertions) {
            if (fault === 'skip') assertion['executed'] = false;
            else delete assertion['zero'];
          }
        }
        await editsArtifact(root, edit);
      }
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      assert.ok(report.blockers.length > 0);
      assert.doesNotMatch(JSON.stringify(report), /Expected result|private\.json/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const id of ['ownership.last_owner_refused', 'regressions.phase2', 'regressions.phase3']) {
  test(`partial evidence preserves completed conditions and names missing ${id}`, async function () {
    const { root, input } = await prepared();
    try {
      function edit(artifact: Record<string, unknown>) {
        const assertions = artifact['assertions'] as Array<Record<string, unknown>>;
        function other(assertion: Record<string, unknown>) { return assertion['id'] !== id; }
        artifact['assertions'] = assertions.filter(other);
      }
      await editsArtifact(root, edit);
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      assert.equal(report.completed.length, Object.keys(companyConditions).length * 4 - 1);
      assert.deepEqual(report.blockers, [`install 1 / 1280 / ${id}: NOT RUN`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
