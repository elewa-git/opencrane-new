import { memberAuthorisation } from '@opencrane/authz';
import { MemberAccessRefused } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import { createHash } from 'node:crypto';
import type { MemberAccessRow, ToolExplanation, ToolPolicy } from '@opencrane/protocol';
import type { GroupOptions } from '../members/group-routes.ts';
import type { memberInventory } from '../members/inventory.ts';

type Inventory = Awaited<ReturnType<typeof memberInventory>>;

export async function explanationPolicy(options: GroupOptions, serverId: string,
  deadline: number) {
  const rows = [];
  for await (const row of options.store.readStream(`mcp-${serverId}`, 1, deadline)) {
    if (row.event.silo !== options.silo) {
      throw new MemberAccessRefused('Wrong silo');
    }
    if (rows.length >= 10_000 || performance.now() >= deadline) {
      throw new Error('Tool history limit exceeded');
    }
    rows.push(row);
  }
  let policy = emptyToolPolicy();
  for (const row of rows) {
    policy = applyToolPolicy(policy, row.event, row.sequence);
  }
  return { ...policy, published: isToolPolicyAvailable(policy) };
}

type CheckedGrant = ToolExplanation['person'];

function permissionReasons(person: CheckedGrant, assistant: CheckedGrant, actsFor: CheckedGrant) {
  const reasons: string[] = [];
  if (person === 'denied') {
    reasons.push('missing_requester_grant');
  }
  if (assistant === 'denied') {
    reasons.push('missing_assistant_grant');
  }
  if (actsFor === 'denied') {
    reasons.push('cannot_act_for_assistant');
  }
  if ([person, assistant, actsFor].includes('unavailable')) {
    reasons.push('iam_unavailable');
  }
  return reasons;
}

function requireCompleteGrantAbsence(inventory: Inventory, row: MemberAccessRow | undefined,
  person: CheckedGrant, assistant: CheckedGrant) {
  if (inventory.grantInputsComplete) {
    return;
  }
  // Check only access inputs. Delayed chat tables cannot change a saved grant.
  if (!row || person === 'denied' || assistant === 'denied') {
    throw new Error('Grant absence could not be checked completely');
  }
}

export async function checkedToolGrants(options: GroupOptions, inventory: Inventory,
  requesterId: string, serverId: string, assistantId: string) {
  function matchesServer(row: MemberAccessRow) {
    return row.resourceType === 'mcp_server' && row.resourceId === serverId;
  }
  function matchesAssistant(assistant: MemberAccessRow['eligibility']['assistants'][number]) {
    return assistant.assistantId === assistantId;
  }
  const row = inventory.rows.find(matchesServer);
  const savedAssistant = row?.eligibility.assistants.find(matchesAssistant);
  const auth = memberAuthorisation(options.binding);
  let person: CheckedGrant = row?.eligibility.person ?? 'denied';
  const assistant: CheckedGrant = savedAssistant?.grant ?? 'denied';
  requireCompleteGrantAbsence(inventory, row, person, assistant);
  if (!row) {
    const permission = await auth.use('person', requesterId, 'mcp_server', serverId);
    if (permission.status === 'unavailable' || permission.allowed) {
      throw new Error('Permission and saved grant absence could not be confirmed');
    }
  }
  // Require a saved requester source even if IAM still returns a revoked permission.
  function requesterSource(source: MemberAccessRow['sources'][number]) {
    return source.granteeKind === 'member' || source.kind === 'group';
  }
  if (person === 'allowed' && !row?.sources.some(requesterSource)) {
    if (!inventory.grantInputsComplete) {
      throw new Error('Requester grant inputs could not be checked completely');
    }
    person = 'denied';
  }
  const acting = await auth.actsFor(requesterId, assistantId);
  let actsFor: CheckedGrant = 'denied';
  if (acting.status === 'unavailable') {
    actsFor = 'unavailable';
  } else if (acting.allowed) {
    actsFor = 'allowed';
  }
  const reasons = permissionReasons(person, assistant, actsFor);
  return { person, assistant, actsFor, reasons };
}

function policyReasons(policy: ToolPolicy, tool: ToolPolicy['tools'][number] | undefined,
  profile: ToolExplanation['profile'], freshness: ToolExplanation['freshness']) {
  const reasons = ['publication_unavailable'];
  if (profile === 'absent_on_version') {
    reasons.push('profile_not_available_yet');
  } else if (profile !== 'not_required') {
    reasons.push('profile_unavailable');
  }
  if (!tool) {
    reasons.push('tool_not_found');
  }
  if (!tool?.reviewed) {
    reasons.push('review_required');
  }
  if (tool?.mode === 'block') {
    reasons.push('tool_blocked');
  }
  if (!policy.published) {
    reasons.push('not_published');
  }
  if (freshness !== 'current') {
    reasons.push('catalogue_not_current');
  }
  return reasons;
}

export function explainTool(inventory: Inventory, assistantId: string, toolName: string,
  policy: ToolPolicy, grants: Awaited<ReturnType<typeof checkedToolGrants>>): ToolExplanation {
  function matchesTool(tool: ToolPolicy['tools'][number]) {
    return tool.name === toolName;
  }
  const tool = policy.tools.find(matchesTool);
  let profile: ToolExplanation['profile'] = inventory.personalConnections.status;
  if (policy.accountMode === 'none') {
    profile = 'not_required';
  }
  let freshness: ToolExplanation['freshness'] = 'unavailable';
  const now = Date.now();
  if (policy.checkedAt && policy.expiresAt && Date.parse(policy.checkedAt) <= now &&
      Date.parse(policy.expiresAt) > now) {
    freshness = 'current';
  }
  const policyRefusals = policyReasons(policy, tool, profile, freshness);
  const reasons = [...grants.reasons, ...policyRefusals];
  if (!inventory.complete) {
    reasons.push('inventory_unavailable');
  }
  // Keep availability closed until the gateway can acknowledge this exact publication.
  return { assistantId, toolName, checkedAt: new Date().toISOString(),
    person: grants.person, assistant: grants.assistant, actsFor: grants.actsFor,
    profile, mode: tool?.mode ?? null,
    review: tool?.reviewed ? 'current' : 'unavailable', publication: 'unavailable', freshness,
    policySequence: policy.sequence, policyRevision: policy.policyRevision,
    catalogueCheckedAt: policy.checkedAt, catalogueExpiresAt: policy.expiresAt,
    availability: 'unavailable', reasons };
}

export function toolReviewRevision(inventoryRevision: string, policy: ToolPolicy) {
  const hash = createHash('sha256');
  const positions = [inventoryRevision, policy.sequence, policy.policyRevision];
  hash.update(JSON.stringify(positions));
  return hash.digest('hex');
}

export async function extendToolAvailability(options: GroupOptions, memberId: string,
  inventory: Inventory, deadline: number) {
  for (const row of inventory.rows) {
    if (row.resourceType !== 'mcp_server') {
      continue;
    }
    const policy = await explanationPolicy(options, row.resourceId, deadline);
    const completePolicy = policy.catalogue !== null &&
      policy.catalogue.toolCount === policy.tools.length;
    const explanations: ToolExplanation[] = [];
    let overflow = false;
    for (const assistant of row.eligibility.assistants) {
      const grants = await checkedToolGrants(options, inventory, memberId, row.resourceId,
        assistant.assistantId);
      for (const tool of policy.tools) {
        if (explanations.length >= 50) {
          overflow = true;
          break;
        }
        if (performance.now() >= deadline) {
          throw new Error('Tool explanation deadline exceeded');
        }
        const explanation = explainTool(inventory, assistant.assistantId, tool.name,
          policy, grants);
        explanations.push(explanation);
      }
      if (overflow) {
        break;
      }
    }
    row.eligibility.toolExplanations = explanations;
    row.eligibility.toolExplanationTotal = null;
    if (!overflow && completePolicy) {
      row.eligibility.toolExplanationTotal = explanations.length;
    }
    if (!completePolicy) {
      inventory.unavailableSections.push('tool_policy');
    }
    if (overflow) {
      inventory.unavailableSections.push('tool_limits');
    }
  }
}
