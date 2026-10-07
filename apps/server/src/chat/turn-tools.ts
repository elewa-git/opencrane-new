import { createHash } from 'node:crypto';
import { createLogger } from '@opencrane/observability';

const maximumToolBytes = 48 * 1024;
const maximumTurnBytes = 120 * 1024;
const maximumServers = 20;
const rootFieldBytes = Buffer.byteLength(',"tools":[]', 'utf8');

export interface TurnToolServerState {
  serverId: string;
  connectionId: string | null;
  published: boolean;
  accountMode: 'none' | 'personal' | 'company' | null;
  serverInfo?: { name: string; version: string };
  discoveryTools: {
    name: string;
    revision: string;
    definition?: string;
  }[];
  policyTools: {
    name: string;
    revision: string;
    reviewed: boolean;
    costCents?: number;
    mode: 'allow' | 'ask' | 'block';
  }[];
}

interface TurnToolInput {
  rows: { serverId: string }[];
  requesterId: string;
  assistantId: string;
  baseMessageBytes: number;
  readServer: (serverId: string) => Promise<TurnToolServerState | undefined>;
  canUse: (serverId: string, kind: 'person' | 'assistant', subject: string) =>
    Promise<boolean>;
}

interface TurnToolServer {
  key: string;
  serverId: string;
  connectionId: string;
  serverInfo?: { name: string; version: string };
  definitions: string[];
}

export interface TurnDelivery {
  turnId: string;
  sentAt: number;
  tools: TurnToolServer[];
}

const logger = createLogger('bridge');

export async function buildTurnTools(input: TurnToolInput): Promise<TurnToolServer[]> {
  const availableBytes = Math.min(maximumToolBytes,
    maximumTurnBytes - input.baseMessageBytes - rootFieldBytes);
  if (availableBytes <= 0) {
    logOmittedServers(input.rows.length);
    return [];
  }

  const tools: TurnToolServer[] = [];
  const keys = new Set<string>();
  let omittedServers = 0;
  for (const row of input.rows) {
    const state = await input.readServer(row.serverId);
    if (!state || !isAvailableServer(state)) continue;
    if (!hasComputerCompatibleFields(state)) {
      omittedServers += 1;
      continue;
    }
    const definitions = reviewedAllowDefinitions(state);
    if (!definitions.length) continue;
    if (!await canUseServer(input, state.serverId)) continue;
    const entry = makeTurnToolServer(state, definitions);
    if (keys.has(entry.key) || tools.length >= maximumServers ||
        !fitsBudget(tools, entry, availableBytes)) {
      omittedServers += 1;
      continue;
    }
    tools.push(entry);
    keys.add(entry.key);
  }

  logOmittedServers(omittedServers);
  return tools;
}

export async function toolsForMessage(
  sentTurns: Map<string, TurnDelivery>,
  conversationId: string,
  turnId: string,
  build: () => Promise<TurnToolServer[]>,
) {
  const previous = sentTurns.get(conversationId);
  if (previous?.turnId === turnId) return previous.tools;
  const tools = await build();
  sentTurns.set(conversationId, { turnId, sentAt: performance.now(), tools });
  return tools;
}

export function mayOfferTurnTools(assistantKind: string, executionMode: string,
  hasBinding: boolean) {
  return assistantKind === 'personal' && executionMode === 'memory_free' && hasBinding;
}

function logOmittedServers(omittedServers: number) {
  if (omittedServers === 0) return;
  logger.info({ operation: 'chat.turn_tools', omittedServers },
    'Some reviewed tool servers were left out of a turn');
}

function isAvailableServer(state: TurnToolServerState) {
  return state.published && state.accountMode === 'none' && state.connectionId !== null;
}

function hasComputerCompatibleFields(state: TurnToolServerState) {
  const validId = /^[\w-]{1,200}$/u;
  if (!validId.test(state.serverId) || !state.connectionId ||
      !validId.test(state.connectionId)) return false;
  if (state.serverInfo && (state.serverInfo.name.length > 200 ||
      state.serverInfo.version.length > 200)) return false;
  return state.discoveryTools.every(hasValidDefinitionLength);
}

function hasValidDefinitionLength(tool: TurnToolServerState['discoveryTools'][number]) {
  return tool.definition === undefined || tool.definition.length <= 32_768;
}

async function canUseServer(input: TurnToolInput, serverId: string) {
  const requesterCanUse = await input.canUse(serverId, 'person', input.requesterId);
  if (!requesterCanUse) return false;
  return input.canUse(serverId, 'assistant', input.assistantId);
}

function reviewedAllowDefinitions(state: TurnToolServerState) {
  const tools: string[] = [];
  for (const policyTool of state.policyTools) {
    if (!policyTool.reviewed || policyTool.costCents !== 0 || policyTool.mode !== 'allow') {
      continue;
    }
    function matchesPolicy(tool: TurnToolServerState['discoveryTools'][number]) {
      return tool.name === policyTool.name && tool.revision === policyTool.revision;
    }
    const discovered = state.discoveryTools.find(matchesPolicy);
    if (!discovered?.definition || !isValidDefinition(discovered.definition)) continue;
    tools.push(discovered.definition);
  }
  return tools;
}

function isValidDefinition(definition: string) {
  try {
    const parsed = JSON.parse(definition) as unknown;
    return parsed !== undefined;
  } catch {
    return false;
  }
}

function makeTurnToolServer(state: TurnToolServerState, definitions: string[]): TurnToolServer {
  if (!state.connectionId) throw new Error('Tool server connection is unavailable');
  const result: TurnToolServer = {
    key: `oc_${createHash('sha256').update(state.serverId).digest('hex').slice(0, 10)}`,
    serverId: state.serverId,
    connectionId: state.connectionId,
    definitions,
  };
  if (state.serverInfo) result.serverInfo = state.serverInfo;
  return result;
}

function fitsBudget(current: TurnToolServer[], candidate: TurnToolServer, budget: number) {
  const next = [...current, candidate];
  return Buffer.byteLength(JSON.stringify(next), 'utf8') <= budget;
}
