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


// Keep the required checks in code so submitted evidence cannot omit unfinished features.
export const companyRequirements: Record<string, string[]> = {
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
  for (const state of states) companyRequirements['screens.accessibility']!.push(`${screen}.${state}`);
}
for (let ticket = 1; ticket <= 27; ticket++) {
  companyRequirements['gates.inherited']!.push(`p4_${ticket}_live_receipt`);
}
for (const stage of ['execution', 'kill_resume', 'replay']) {
  for (const location of ['persistent_volume', 'rollouts', 'compaction', 'soul', 'config',
    'outbox', 'logs', 'temporary_files', 'crash_artifacts']) {
    for (const scope of ['personal', 'group']) {
      companyRequirements['memory.no_disk']!.push(`${stage}.${location}.${scope}`);
    }
  }
}
for (const boundary of ['source_append', 'parent_intent', 'child_creation', 'first_input',
  'activation', 'root_allocation', 'start', 'model_dispatch', 'terminal_report']) {
  companyRequirements['child.creation']!.push(`crash_after.${boundary}`);
}
