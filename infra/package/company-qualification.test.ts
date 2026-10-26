import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCompanyQualification, companyConditions } from './company-qualification.ts';

const source = 'a'.repeat(40);
const image = `local/server@sha256:${'b'.repeat(64)}`;
const expected = { source, image };

const requiredChecks: Record<string, string[]> = {
  'participants': [
    'two_people', 'two_groups', 'distinct_group_facts', 'child_only_invitee', 'admin',
    'second_silo',
  ],
  'groups.list': [
    'actual_membership',
  ],
  'groups.create': [
    'flat_group', 'membership_grant',
  ],
  'groups.search': [
    'search',
  ],
  'groups.detail': [
    'actual_members', 'access_sources',
  ],
  'groups.removal_review': [
    'lost_access_explanation',
  ],
  'groups.remove_member': [
    'new_calls_within_two_seconds', 'sockets_within_two_seconds',
  ],
  'membership.refusals': [
    'same_id_cross_silo', 'unavailable_openfga', 'stale_openfga',
  ],
  'ownership.transfer': [
    'authority_transfer', 'old_owner_retained', 'separate_step_down',
  ],
  'ownership.last_owner_refused': [
    'concurrent_demotions', 'safe_leaver_reassignment',
  ],
  'direct_chat.exchange_and_no_agent': [
    'send', 'receive', 'no_ai_effects',
  ],
  'group_chat.exchange_and_no_agent': [
    'send', 'receive', 'no_ai_effects',
  ],
  'chat.lifecycle': [
    'send', 'reload', 'reconnect', 'paginate', 'close', 'archive', 'unread',
    'participant_changes',
  ],
  'chat.refusals': [
    'mode_mutation', 'nonparticipant', 'closed', 'foreign',
  ],
  'shared_assistant.created': [
    'create', 'select', 'reviewed_grants', 'payer',
  ],
  'shared_assistant.private_chat': [
    'simultaneous_credentials', 'simultaneous_tokens', 'simultaneous_memory', 'one_computer',
    'follow_up_requester_change',
  ],
  'child.creation': [
    'crash_at_each_boundary', 'one_child', 'one_activation', 'explicit_assistant',
    'explicit_payer',
  ],
  'child.navigation': [
    'starting', 'working', 'waiting', 'retrying', 'terminal', 'closed', 'restricted',
    'back_restores_position',
  ],
  'child.disclosure': [
    'frozen_audience', 'late_child_join', 'full_history', 'independent_parent_rights',
    'removed_viewer_purge', 'guessed_ids', 'late_http', 'late_socket', 'restricted_no_text',
    'restricted_no_counts', 'restricted_no_assets',
  ],
  'child.publish': [
    'human_review', 'immediate_parent', 'retry_once', 'closed_parent', 'revoked_parent',
    'private_assets',
  ],
  'delegation.money': [
    'concurrent_children_root_allowance', 'retry_root_allowance', 'one_charge',
    'unknown_usage_held', 'late_charge_settled_once',
  ],
  'delegation.refusals': [
    'altered_root', 'altered_payer', 'altered_requester', 'altered_computer', 'altered_scopes',
    'stop_descendants', 'exhaustion_descendants', 'old_reservations',
  ],
  'memory.tools': [
    'remember_personal', 'remember_assistant_notes', 'remember_group', 'recall_personal',
    'recall_assistant_notes', 'recall_group', 'correct_personal', 'correct_assistant_notes',
    'correct_group', 'forget_personal', 'forget_assistant_notes', 'forget_group',
    'approval_free_group_write', 'exact_search', 'partial_search', 'ranking', 'bounded_results',
    'empty_search', 'preferences', 'pins',
  ],
  'memory.refusals': [
    'cross_person_read', 'cross_person_write', 'cross_person_search', 'cross_person_pin',
    'assistant_notes_read', 'assistant_notes_write', 'assistant_notes_search',
    'assistant_notes_pin', 'group_read', 'group_write', 'group_search', 'group_pin',
    'cross_silo_read', 'cross_silo_write', 'cross_silo_search', 'cross_silo_pin',
    'forged_scope_headers',
  ],
  'memory.deletion': [
    'correction_races', 'multibyte_pin_cap', 'multibyte_preference_cap', 'stale_context',
    'forget_after_merge', 'forget_after_dreaming', 'key_deletion_failure', 'restart',
    'tombstones_after_replay', 'dependants_after_replay', 'disabled_model_endpoints',
  ],
  'memory.no_disk': [
    'personal_canary', 'group_canary', 'native_codex_gvisor', 'attempt_file_write',
    'attempt_shell_write', 'attempt_browser_write', 'execution.persistent_volume',
    'execution.rollouts', 'execution.compaction', 'execution.soul', 'execution.config',
    'execution.outbox', 'execution.logs', 'execution.temporary_files',
    'execution.crash_artifacts', 'kill_resume.persistent_volume', 'kill_resume.rollouts',
    'kill_resume.compaction', 'kill_resume.soul', 'kill_resume.config', 'kill_resume.outbox',
    'kill_resume.logs', 'kill_resume.temporary_files', 'kill_resume.crash_artifacts',
    'replay.persistent_volume', 'replay.rollouts', 'replay.compaction', 'replay.soul',
    'replay.config', 'replay.outbox', 'replay.logs', 'replay.temporary_files',
    'replay.crash_artifacts',
  ],
  'memory.isolation': [
    'personal_other_prompt', 'personal_shared_notes', 'personal_instructions',
    'personal_summary', 'personal_published', 'group_other_prompt', 'group_shared_notes',
    'group_instructions', 'group_summary', 'group_published', 'authorised_sharing',
  ],
  'dreaming': [
    'nightly_boundary', 'one_scope_date_batch', 'capped_spend', 'merge', 'contradictions',
    'expiry', 'pinned_protection', 'crash', 'lost_reply', 'concurrent_correction',
    'concurrent_forget',
  ],
  'dreaming.refusals': [
    'missing_owner', 'missing_grant', 'missing_model', 'missing_payer', 'missing_price',
  ],
  'onboarding': [
    'sign_in', 'invite', 'survey_reload', 'survey_edit', 'survey_restart', 'persona_review',
    'no_agent_welcome', 'ordered_completion', 'read_only_completion', 'archive_completion',
    'read_only_sso',
  ],
  'admin.refusals': [
    'wrong_invite_account', 'expired_invite', 'absent_email_service', 'role_denial',
    'safe_removal',
  ],
  'providers.key_save': [
    'no_browser_storage', 'no_events', 'no_logs', 'verify_skip', 'unknown_save_reconciliation',
  ],
  'providers.paid_model_answer': [
    'remaining_500_cent_allowance', 'provider_cap', 'authorised_answer',
  ],
  'routines': [
    'daily', 'weekly', 'timezone', 'dst', 'two_schedulers', 'restart', 'missed_occurrence',
    'overlapping_occurrence', 'company_identity_upstream',
  ],
  'routines.refusals': [
    'revoked_owner', 'revoked_company_profile', 'budget_denied', 'ask_original_owner',
    'timeout_stops', 'no_personal_fallback',
  ],
  'replay.zero_effects': [
    'postgresql_rebuild', 'openfga_rebuild', 'all_membership_tuples', 'fact_ids', 'revisions',
    'search', 'ui', 'audit', 'budgets', 'disabled_model_endpoints', 'no_model_dispatch',
    'no_tool_dispatch', 'no_routine_dispatch',
  ],
  'recovery': [
    'replace_computer_pod', 'authorised_context', 'no_private_session_files',
    'duplicate_routine_no_effect', 'duplicate_routine_no_spend',
    'duplicate_delegation_no_effect', 'duplicate_delegation_no_spend',
  ],
  'regressions.phase2': [
    'reload_journey', 'pod_recovery_journey',
  ],
  'regressions.phase3': [
    'odoo_rights', 'odoo_read', 'approved_write', 'oauth', 'policy_refusals',
    'paying_group_hard_stop', 'audited_takeover',
  ],
  'screens.accessibility': [
    'delivered_screen_state_inventory', 'desktop_comparisons', 'phone_comparisons', 'dialogs',
    'loading', 'empty', 'error', 'unknown_outcome', 'changed_access', 'long_content', 'keyboard',
    'assistive_technology', 'reduced_motion',
  ],
  'gates.inherited': [
    'p5_11_live_receipt', 'p5_12_live_receipt', 'p4_28_live_receipt',
    'feature_dependency_receipts', 'deleted_keys_restore', 'forgotten_facts_unavailable',
  ],
};

const screenChecks: Record<string, string[]> = {
  groups: ['list', 'detail', 'add', 'remove', 'empty', 'error', 'access_changed', 'long_names'],
  ownership: ['review', 'success', 'unknown_outcome', 'conflict'],
  members: ['invite', 'roles', 'departure', 'read_only', 'unknown_outcome', 'last_owner_conflict'],
  direct_chat: ['to_line', 'transcript', 'composer', 'loading', 'error', 'reconnect'],
  group_chat: ['list', 'transcript', 'people_picker', 'long_names', 'empty', 'denied', 'stale'],
  conversations: ['recent', 'archived', 'close_review', 'empty', 'loading', 'pagination',
    'unavailable', 'long_title'],
  assistants: ['create', 'detail', 'selection', 'session', 'provisioning', 'failed', 'removed', 'busy'],
  children: ['composer', 'source_summary', 'queued', 'failed_start', 'starting', 'working',
    'waiting', 'retrying', 'terminal', 'closed', 'restricted', 'long_breadcrumbs', 'origin',
    'back', 'access_changed', 'follow_up', 'invitation'],
  publication: ['preview', 'success', 'conflict', 'unknown_outcome', 'denied_asset'],
  delegation: ['running', 'completed', 'failed', 'cancelled', 'stop', 'partial', 'exhausted'],
  memory: ['list', 'search', 'store', 'empty', 'stored', 'denied', 'unavailable', 'edit',
    'forget_review', 'receipt', 'batch', 'source_unavailable', 'conflict', 'access_changed',
    'recovering', 'resumed', 'unavailable_context', 'restricted_tool', 'undo', 'omitted_context',
    'trail', 'maintenance_failed', 'held_spend'],
  account: ['settings', 'preferences', 'no_assistant', 'saving', 'unknown', 'access_changed'],
  onboarding: ['survey_one', 'survey_two', 'survey_three', 'survey_four', 'review', 'validation',
    'save_unknown', 'restart', 'welcome', 'interrupted', 'reload', 'read_only', 'no_agent', 'complete'],
  providers: ['list', 'detail', 'setup', 'replace_key'],
  models: ['table', 'access_editor', 'dependency_review', 'retired_provider'],
  integrations: ['4a', '4b', '4c', '4d', '4e', '4f', '4g'],
  routines: ['create', 'detail', 'next_run', 'recent_result', 'schedule_change', 'ask', 'paused',
    'access_changed', 'skipped', 'unknown', 'history'],
  spending: ['summary', 'edit', 'conflict', 'exhausted', 'rollover', 'unknown_spend'],
  admin: ['overview', 'change_history', 'shared_states', 'stacked_rows', 'top_navigation',
    'stale_data', 'busy_row', 'unknown_outcome', 'access_changed'],
};
for (const [screen, states] of Object.entries(screenChecks)) {
  for (const state of states) requiredChecks['screens.accessibility']!.push(`${screen}.${state}`);
}
for (let ticket = 1; ticket <= 27; ticket++) {
  requiredChecks['gates.inherited']!.push(`p4_${ticket}_live_receipt`);
}
for (const stage of ['execution', 'kill_resume', 'replay']) {
  for (const location of ['persistent_volume', 'rollouts', 'compaction', 'soul', 'config',
    'outbox', 'logs', 'temporary_files', 'crash_artifacts']) {
    for (const scope of ['personal', 'group']) {
      requiredChecks['memory.no_disk']!.push(`${stage}.${location}.${scope}`);
    }
  }
}
for (const boundary of ['source_append', 'parent_intent', 'child_creation', 'first_input',
  'activation', 'root_allocation', 'start', 'model_dispatch', 'terminal_report']) {
  requiredChecks['child.creation']!.push(`crash_after.${boundary}`);
}

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
  function evidenceRun(value: ReturnType<typeof run>) {
    return { fresh: { kind: 'fresh-install', state: value.state }, artifacts: [] as string[] };
  }
  return { journey, runs: runs.map(evidenceRun) };
}

async function prepared() {
  const root = await mkdtemp(join(tmpdir(), 'company-check-'));
  const input = fixture();
  for (let index = 0; index < 2; index++) {
    for (const width of [1280, 390]) {
      const proofName = `${index}-${width}-results.json`;
      const supportName = `${index}-${width}-capture.txt`;
      function resultLink(requirement: string) { return { requirement, evidence: proofName }; }
      function assertion(id: string) {
        return { id, status: 'PASS', executed: true, expected: 'Expected result',
          observed: 'Observed result', results: requiredChecks[id]!.map(resultLink), zero: { model: 0, tool: 0, routine: 0,
            wake: 0, approval: 0, reservation: 0, upstream: 0, turn: 0,
            persistentCanary: 0, foreignCanary: 0, groupWriteApproval: 0 } };
      }
      const assertions = Object.keys(companyConditions).map(assertion);
      const artifact = { kind: 'company-journey', binding: input.journey.runs[index]!.binding,
        width, date: '2026-10-26T12:01:00.000Z', command: 'synthetic test only', assertions };
      const results = [];
      for (const assertion of assertions) {
        for (const result of assertion.results) {
          results.push({ id: assertion.id, requirement: result.requirement, status: 'PASS',
            executed: true, expected: assertion.expected, observed: assertion.observed,
            zero: assertion.zero, links: [supportName] });
        }
      }
      const proof = { kind: 'company-results', binding: artifact.binding, width,
        date: artifact.date, command: artifact.command, results };
      await writeFile(join(root, proofName), JSON.stringify(proof));
      await writeFile(join(root, supportName), 'Synthetic capture only; no live qualification.');
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

async function checksSyntheticEvidence() {
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
}
test('synthetic evidence checks logic without a qualification PASS', checksSyntheticEvidence);

test('human group chat has its own zero-effect condition', function () {
  assert.ok(Object.hasOwn(companyConditions, 'group_chat.exchange_and_no_agent'));
});

for (const fault of ['installId', 'pvcUids', 'pvUids', 'storeId', 'namespaceUid', 'releaseUid',
  'restored', 'source', 'image', 'width', 'stage-a', 'stage-b', 'skip', 'zero', 'foreign',
  'escape', 'symlink', 'oversize', 'count'] as const) {
  async function refusesFullAcceptance() {
    const { root, input } = await prepared();
    try {
      const first = input.journey.runs[0]!;
      const second = input.journey.runs[1]!;
      if (fault === 'source' || fault === 'image' || fault === 'installId' ||
        fault === 'pvcUids' || fault === 'pvUids' || fault === 'storeId' ||
        fault === 'namespaceUid' || fault === 'releaseUid') {
        if (fault === 'source' || fault === 'image') first.binding[fault] = fault === 'source'
          ? 'c'.repeat(40) : `local/server@sha256:${'d'.repeat(64)}`;
        else Object.assign(second.binding, { [fault]: first.binding[fault] });
      }
      if (fault === 'restored') input.runs[0]!.fresh.state.rowCounts.memory_changes = 1;
      if (fault === 'width') input.runs[0]!.artifacts.pop();
      if (fault === 'stage-a' || fault === 'stage-b') {
        Object.assign(input.journey, { status: 'PASS', stage: fault, screenshots: ['screen.png'] });
      }
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
            else if (assertion['id'] === 'group_chat.exchange_and_no_agent') {
              delete assertion['zero'];
            }
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
  }
  test(`refuses full acceptance: ${fault}`, refusesFullAcceptance);
}

for (const id of Object.keys(companyConditions)) {
  async function preservesCompletedConditions() {
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
  }
  test(`partial evidence names missing ${id}`, preservesCompletedConditions);
}

async function editsProof(root: string, edit: (proof: Record<string, unknown>) => void) {
  const path = join(root, '0-1280-results.json');
  const proof = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(proof);
  await writeFile(path, JSON.stringify(proof));
}

function onlyInstallTwo(completed: string[]) {
  assert.equal(completed.length, Object.keys(companyConditions).length * 2);
  for (const condition of completed) assert.match(condition, /^install 2 /u);
}

async function refusesStubOnlyProbe() {
  const { root, input } = await prepared();
  try {
    for (const run of input.runs) {
      for (const name of run.artifacts) {
        const path = join(root, name);
        const artifact = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const assertions = artifact['assertions'] as Array<Record<string, unknown>>;
        for (const assertion of assertions) {
          assertion['observed'] = 'Only a stub reply was checked; no captures or native proof.';
          delete assertion['results'];
        }
        await writeFile(path, JSON.stringify(artifact));
      }
    }
    const report = await checkCompanyQualification(root, input, expected);
    assert.equal(report.complete, false);
    assert.deepEqual(report.completed, []);
    assert.equal(report.status, 'NOT RUN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('the review stub-only probe cannot complete any condition', refusesStubOnlyProbe);

for (const [id, requirements] of Object.entries(requiredChecks)) {
  for (const requirement of requirements) {
    async function refusesMissingSubcondition() {
      const { root, input } = await prepared();
      try {
        function edit(proof: Record<string, unknown>) {
          const results = proof['results'] as Array<Record<string, unknown>>;
          function other(result: Record<string, unknown>) {
            return result['id'] !== id || result['requirement'] !== requirement;
          }
          proof['results'] = results.filter(other);
        }
        await editsProof(root, edit);
        const report = await checkCompanyQualification(root, input, expected);
        assert.equal(report.complete, false);
        assert.equal(report.completed.length, Object.keys(companyConditions).length * 4 - 1);
        assert.deepEqual(report.blockers, [`install 1 / 1280 / ${id} / ${requirement}: NOT RUN`]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    test(`requires linked result: ${id} / ${requirement}`, refusesMissingSubcondition);
  }
}

for (const fault of ['missing link', 'missing file', 'empty file', 'escape', 'symlink',
  'foreign binding', 'foreign width', 'old date', 'duplicate result', 'failed', 'skipped',
  'missing zero', 'positive zero', 'unlinked results'] as const) {
  async function refusesInvalidSubcondition() {
    const { root, input } = await prepared();
    try {
      function edit(proof: Record<string, unknown>) {
        const results = proof['results'] as Array<Record<string, unknown>>;
        const result = results.find(isNativeResult)!;
        if (fault === 'missing link') result['links'] = [];
        if (fault === 'missing file') result['links'] = ['absent-private-file'];
        if (fault === 'escape') result['links'] = ['../private-file'];
        if (fault === 'symlink') result['links'] = ['linked-capture'];
        if (fault === 'foreign binding') {
          proof['binding'] = { ...input.journey.runs[1]!.binding };
        }
        if (fault === 'foreign width') proof['width'] = 390;
        if (fault === 'old date') proof['date'] = '2026-10-25T12:00:00.000Z';
        if (fault === 'duplicate result') results.push({ ...result });
        if (fault === 'failed') result['status'] = 'FAIL';
        if (fault === 'skipped') result['executed'] = false;
        if (fault === 'missing zero') delete result['zero'];
        if (fault === 'positive zero') result['zero'] = { persistentCanary: 1 };
      }
      function isNativeResult(result: Record<string, unknown>) {
        return result['id'] === 'memory.no_disk' &&
          result['requirement'] === 'native_codex_gvisor';
      }
      if (fault === 'empty file') await writeFile(join(root, '0-1280-capture.txt'), '');
      if (fault === 'symlink') {
        await symlink(join(root, '0-1280-capture.txt'), join(root, 'linked-capture'));
      }
      if (fault === 'unlinked results') {
        function unlink(artifact: Record<string, unknown>) {
          const assertions = artifact['assertions'] as Array<Record<string, unknown>>;
          for (const assertion of assertions) assertion['results'] = [];
        }
        await editsArtifact(root, unlink);
      }
      await editsProof(root, edit);
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      assert.ok(!report.completed.includes('install 1 / 1280 / memory.no_disk'));
      assert.ok(report.completed.includes('install 2 / 1280 / memory.no_disk'));
      assert.doesNotMatch(JSON.stringify(report), /private-file|Expected result/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  test(`refuses unsupported subcondition: ${fault}`, refusesInvalidSubcondition);
}

for (const fault of ['memory_changes', 'installId', 'storeId', 'installedAt', 'pvcs', 'pvs']) {
  async function dropsUnfreshConditions() {
    const { root, input } = await prepared();
    try {
      const state = input.runs[0]!.fresh.state;
      if (fault === 'memory_changes') state.rowCounts.memory_changes = 1;
      else Object.assign(state, { [fault]: 'unaccepted' });
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      onlyInstallTwo(report.completed);
      assert.ok(report.blockers.includes('install 1: fresh empty state NOT RUN'));
      assert.ok(report.blockers.includes('install 1 / 1280 / memory.no_disk: NOT RUN'));
      assert.ok(report.blockers.includes('install 1 / 390 / regressions.phase3: NOT RUN'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  test(`rejected freshness drops only its install: ${fault}`, dropsUnfreshConditions);
}

for (const field of ['source', 'image', 'context', 'namespace', 'origin', 'installedAt']) {
  async function preservesOtherBinding() {
    const { root, input } = await prepared();
    try {
      const foreign = { source: 'c'.repeat(40), image: `local/server@sha256:${'d'.repeat(64)}`,
        context: 'foreign-private-context', namespace: 'foreign-private-namespace',
        origin: 'https://foreign-private-origin', installedAt: 'not-a-date' };
      Object.assign(input.journey.runs[0]!.binding, { [field]: foreign[field as keyof typeof foreign] });
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      assert.equal(report.status, 'PARTIAL');
      onlyInstallTwo(report.completed);
      assert.ok(report.blockers.includes(`install 1: journey binding ${field} refused`));
      assert.doesNotMatch(JSON.stringify(report), /foreign-private|not-a-date/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  test(`bad binding preserves the other install and names ${field}`, preservesOtherBinding);
}

for (const field of ['namespaceUid', 'releaseUid', 'installId', 'storeId', 'pvcUids', 'pvUids']) {
  async function namesSharedReuse() {
    const { root, input } = await prepared();
    try {
      const first = input.journey.runs[0]!.binding;
      Object.assign(input.journey.runs[1]!.binding, { [field]: first[field as keyof typeof first] });
      const report = await checkCompanyQualification(root, input, expected);
      assert.equal(report.complete, false);
      assert.ok(report.blockers.includes(`shared: reused ${field} refused`));
      assert.ok(report.completed.includes('install 1 / 1280 / memory.no_disk'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  test(`cross-install reuse is a shared blocker: ${field}`, namesSharedReuse);
}

async function reportsReuseAlongsideBadSource() {
  const { root, input } = await prepared();
  try {
    input.journey.runs[0]!.binding.source = 'c'.repeat(40);
    input.journey.runs[1]!.binding.namespaceUid = input.journey.runs[0]!.binding.namespaceUid;
    const report = await checkCompanyQualification(root, input, expected);
    assert.equal(report.complete, false);
    assert.ok(report.blockers.includes('install 1: journey binding source refused'));
    assert.ok(report.blockers.includes('shared: reused namespaceUid refused'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('shared identity reuse remains visible beside a refused source', reportsReuseAlongsideBadSource);
