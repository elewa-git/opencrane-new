import { validateMcpCatalogue, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { getEventDefinition, hostedCredentialContractSchema, mcpServerDiscoveredDataSchema,
  mcpServerReviewedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import { z } from 'zod';

type Catalogue = ReturnType<typeof mcpServerDiscoveredDataSchema.parse>;

export function emptyToolPolicy(): ToolPolicy {
  return { silo: null, serverId: null, connectionId: null, accountMode: null,
    published: false, sequence: 0,
    policyRevision: 0, catalogue: null, previousCatalogue: null,
    checkedAt: null, expiresAt: null, tools: [] };
}

export function applyToolPolicy(state: ToolPolicy, event: EventEnvelope, sequence: number): ToolPolicy {
  const definition = getEventDefinition(event.type);
  const parsed = definition?.dataSchema.parse(event.data);
  const data = z.record(z.string(), z.unknown()).parse(parsed);
  checkPolicyIdentity(state, event, data);
  const identity = { silo: event.silo, serverId: String(data['serverId']) };
  if (event.type === 'mcp.catalogue_checked') {
    return applyCheck(state, data, sequence);
  }
  // Keep approval bindings stable when only the check date changes.
  let next: ToolPolicy = { ...state, ...identity, sequence, policyRevision: sequence };
  if (event.type === 'mcp.server_registered') {
    const startupReviewRequired = requiresStartupReview(data);
    next = { ...emptyToolPolicy(), ...identity, sequence, policyRevision: sequence, startupReviewRequired };
  }
  if (event.type === 'mcp.server_discovered') {
    const catalogue = mcpServerDiscoveredDataSchema.parse(parsed);
    next = applyCapture(next, state.catalogue, catalogue);
  }
  if (event.type === 'mcp.server_reviewed') {
    const review = mcpServerReviewedDataSchema.parse(parsed);
    const tools = reviewedToolChoices(state, review, Date.parse(event.time));
    if (!tools || event.principal?.kind !== 'human' || event.principal.id !== review.reviewedBy) {
      throw new Error('Tool review does not match the saved catalogue');
    }
    next.tools = tools;
    next.published = keepsPublication(state, tools);
  }
  if (event.type === 'mcp.server_published') {
    next.published = state.startupReviewRequired !== true;
  }
  if (event.type === 'mcp.server_rejected' && isStartupRefusal(data)) {
    next.startupReviewRequired = true;
  }
  if (['mcp.server_unpublished', 'mcp.server_rejected', 'mcp.tools_changed'].includes(event.type)) {
    next.published = false;
  }
  if (event.type === 'mcp.tools_changed') {
    next = applyChange(next, state, data);
  }
  if (event.type === 'mcp.tool_mode_set') {
    next.tools = applyMode(state, data);
    next.published = keepsPublication(state, next.tools);
  }
  return toolPolicySchema.parse(next);
}

function requiresStartupReview(data: Record<string, unknown>) {
  const contract = hostedCredentialContractSchema.safeParse(data['credentialContract']);
  return data['kind'] === 'hosted' && contract.success &&
    contract.data.credentialMode !== 'per_call';
}

function isStartupRefusal(data: Record<string, unknown>) {
  return data['reason'] === 'startup_contract_unverified' ||
    data['reason'] === 'lasting_startup_secret_required';
}

function applyCapture(next: ToolPolicy, previous: Catalogue | null, catalogue: Catalogue) {
  if (catalogue.checkedAt !== undefined) {
    validateMcpCatalogue(catalogue);
  }
  const declarations = catalogue.tools ?? [];
  const names = new Set<string>();
  for (const tool of declarations) {
    if (names.has(tool.name)) {
      throw new Error('Duplicate tool names');
    }
    names.add(tool.name);
  }
  const discovered = declarations.map(discoveredTool);
  let tools = discovered;
  if (catalogue.checkedAt === undefined) {
    tools = discovered.map(blockTool);
  }
  return { ...next, catalogue, previousCatalogue: previous,
    checkedAt: catalogue.checkedAt ?? null, expiresAt: catalogue.expiresAt ?? null,
    published: false, connectionId: catalogue.connectionId ?? null,
    accountMode: catalogue.accountMode ?? null, tools };
}

function discoveredTool(tool: NonNullable<Catalogue['tools']>[number]): ToolPolicy['tools'][number] {
  const readOnly = tool.readOnly === true && tool.destructive !== true;
  const suggestion = readOnly ? 'allow' : 'ask';
  const result: ToolPolicy['tools'][number] = { name: tool.name, revision: tool.revision,
    reviewed: false, readOnly, mode: 'block', suggestion };
  if (tool.costCents === 0) {
    result.costCents = 0;
  }
  return result;
}

function applyMode(state: ToolPolicy, data: Record<string, unknown>): ToolPolicy['tools'] {
  if (data['connectionId'] !== state.connectionId) {
    return state.tools;
  }
  function matchesName(tool: { name: string }) {
    return tool.name === data['toolName'];
  }
  const selected = state.tools.find(matchesName);
  if (!selected?.reviewed || selected.revision !== data['toolRevision']) {
    return state.tools;
  }
  const mode = z.enum(['allow', 'ask', 'block']).parse(data['mode']);
  const declaration = state.catalogue?.tools?.find(matchesName);
  if (mode !== 'block' && (selected.costCents !== 0 ||
      (mode === 'ask' && !declaration?.review))) {
    return state.tools;
  }
  function setMode(tool: ToolPolicy['tools'][number]) {
    if (tool === selected) {
      return { ...tool, mode };
    }
    return tool;
  }
  return state.tools.map(setMode);
}

function applyCheck(state: ToolPolicy, data: Record<string, unknown>, sequence: number) {
  if (data['outcome'] === 'failed') {
    return { ...state, sequence, expiresAt: null };
  }
  if (!state.catalogue || data['schemaDigest'] !== state.catalogue.schemaDigest) {
    throw new Error('Catalogue check does not match the saved snapshot');
  }
  validateMcpCatalogue(state.catalogue);
  return { ...state, sequence, checkedAt: String(data['checkedAt']),
    expiresAt: String(data['expiresAt']) };
}

function blockTool(tool: ToolPolicy['tools'][number]): ToolPolicy['tools'][number] {
  return { ...tool, reviewed: false, mode: 'block' };
}

function applyChange(next: ToolPolicy, state: ToolPolicy, data: Record<string, unknown>) {
  if (data['catalogue'] === undefined) {
    const tools = state.tools.map(blockTool);
    return { ...next, previousCatalogue: state.catalogue, catalogue: null,
      checkedAt: null, expiresAt: null, tools };
  }
  const catalogue = mcpServerDiscoveredDataSchema.parse(data['catalogue']);
  if (catalogue.serverId !== data['serverId'] ||
      catalogue.schemaDigest !== data['newSchemaDigest'] ||
      state.catalogue?.schemaDigest !== data['previousSchemaDigest']) {
    throw new Error('Changed catalogue does not match the saved snapshot');
  }
  const changed = applyCapture(next, state.catalogue, catalogue);
  if (catalogue.checkedAt === undefined) {
    return changed;
  }
  function retainUnchangedChoice(tool: ToolPolicy['tools'][number]) {
    function matchesRevision(previous: { name: string; revision: string }) {
      return previous.name === tool.name && previous.revision === tool.revision;
    }
    const previous = state.tools.find(matchesRevision);
    const previousDeclaration = state.catalogue?.tools?.find(matchesRevision);
    const currentDeclaration = catalogue.tools?.find(matchesRevision);
    // Keep a review only for the connection and account it named.
    if (state.connectionId !== changed.connectionId || state.accountMode !== changed.accountMode ||
        !previousDeclaration || !currentDeclaration ||
        toolReviewDigest(previousDeclaration) !== toolReviewDigest(currentDeclaration)) {
      return blockTool(tool);
    }
    return previous ?? blockTool(tool);
  }
  const tools = changed.tools.map(retainUnchangedChoice);
  return { ...changed, tools };
}

export function isToolPolicyAvailable(policy: ToolPolicy, now = Date.now()) {
  if (policy.startupReviewRequired === true) {
    return false;
  }
  return policy.published && policy.catalogue !== null && policy.checkedAt !== null &&
    policy.expiresAt !== null && Date.parse(policy.checkedAt) <= now &&
    Date.parse(policy.expiresAt) > now;
}

function checkPolicyIdentity(state: ToolPolicy, event: EventEnvelope,
  data: Record<string, unknown>): void {
  const serverId = data['serverId'];
  if (event.subject !== `mcp-${String(serverId)}` ||
      (state.serverId !== null && serverId !== state.serverId) ||
      (state.silo !== null && event.silo !== state.silo) ||
      (state.catalogue !== null && serverId !== state.catalogue.serverId)) {
    throw new Error('MCP policy identity mismatch');
  }
}

export function reviewedToolChoices(state: ToolPolicy,
  review: ReturnType<typeof mcpServerReviewedDataSchema.parse>, now: number) {
  const catalogue = state.catalogue;
  if (!catalogue || !matchesReview(state, review, now)) {
    return null;
  }
  validateMcpCatalogue(catalogue);
  const choices = new Map<string, typeof review.tools[number]>();
  for (const choice of review.tools) {
    if (choices.has(choice.name)) {
      return null;
    }
    choices.set(choice.name, choice);
  }
  const tools: ToolPolicy['tools'] = [];
  for (const tool of state.tools) {
    const choice = choices.get(tool.name);
    function matchesName(declaration: NonNullable<Catalogue['tools']>[number]) {
      return declaration.name === tool.name;
    }
    const declaration = catalogue.tools?.find(matchesName);
    if (!choice || !declaration || !matchesChoice(tool, declaration, choice)) {
      return null;
    }
    const reviewed = { ...tool, reviewed: true, mode: choice.mode };
    tools.push(reviewed);
  }
  return tools;
}

function keepsPublication(state: ToolPolicy, tools: ToolPolicy['tools']): boolean {
  const restrictions = { allow: 0, ask: 1, block: 2 };
  for (const tool of tools) {
    function matchesName(previous: ToolPolicy['tools'][number]) {
      return previous.name === tool.name;
    }
    const previous = state.tools.find(matchesName);
    if (!previous || restrictions[tool.mode] < restrictions[previous.mode]) {
      return false;
    }
  }
  return state.published;
}

type Review = ReturnType<typeof mcpServerReviewedDataSchema.parse>;

function matchesReview(state: ToolPolicy, review: Review, now: number): boolean {
  return state.checkedAt !== null && state.expiresAt !== null &&
    Date.parse(state.checkedAt) <= now && Date.parse(state.expiresAt) > now &&
    review.catalogueDigest === state.catalogue?.schemaDigest &&
    review.connectionId === state.connectionId && review.accountMode === state.accountMode &&
    review.policyRevision === state.policyRevision && review.tools.length === state.tools.length;
}

function matchesChoice(tool: ToolPolicy['tools'][number],
  declaration: NonNullable<Catalogue['tools']>[number], choice: Review['tools'][number]): boolean {
  if (choice.revision !== tool.revision || choice.reviewDigest !== toolReviewDigest(declaration)) {
    return false;
  }
  if (choice.mode !== 'block' && declaration.costCents !== 0) {
    return false;
  }
  if (choice.mode === 'ask' && !declaration.review) {
    return false;
  }
  return true;
}
