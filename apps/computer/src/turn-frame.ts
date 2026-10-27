import { modelForTask } from '@opencrane/models/routing';
import { record } from './http.ts';

export interface ToolServer {
  key: string;
  serverId: string;
  connectionId: string;
  serverInfo?: { name: string; version: string };
  definitions: string[];
  modes: Record<string, 'allow' | 'ask'>;
}

export interface Turn {
  executionMode: 'restricted' | 'memory_free';
  sharingClass?: 'shared_only';
  messageId?: string;
  rootId?: string;
  senderAttemptId?: string;
  id: string;
  conversationId: string;
  assistantId: string;
  requesterId?: string;
  text: string;
  token: string;
  expiresAt: number;
  taskKind: string;
  attachments?: unknown;
  omittedAttachments: number;
  tools?: ToolServer[];
}

export function requiredString(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result !== 'string' || !result) {
    throw new Error('Invalid bridge field');
  }
  return result;
}

export function parseTurn(value: Record<string, unknown>): Turn {
  const executionMode = parseExecutionMode(value['executionMode']);
  const sharingClass = parseContextClass(value['sharingClass'], executionMode);
  const expiresAt = value['expiresAt'];
  const taskKind = value['taskKind'] ?? 'chat_turn';
  const omittedAttachments = value['omittedAttachments'] ?? 0;
  if (typeof omittedAttachments !== 'number' || !Number.isSafeInteger(omittedAttachments)
    || omittedAttachments < 0) {
    throw new Error('Invalid attachment count');
  }
  if (typeof taskKind !== 'string') {
    throw new Error('Invalid task kind');
  }
  modelForTask(taskKind);
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
    throw new Error('Expired turn');
  }
  const requesterId = value['requesterId'];
  if (requesterId !== undefined && (typeof requesterId !== 'string' || !requesterId)) {
    throw new Error('Invalid requester');
  }
  const turn: Turn = {
    executionMode,
    id: requiredString(value, 'id'),
    conversationId: requiredString(value, 'conversationId'),
    assistantId: requiredString(value, 'assistantId'),
    text: requiredString(value, 'text'),
    token: requiredString(value, 'token'),
    expiresAt,
    taskKind,
    attachments: value['attachments'],
    omittedAttachments,
  };
  readRoutineTurn(value, turn);
  if (sharingClass) turn.sharingClass = sharingClass;
  if (typeof requesterId === 'string') turn.requesterId = requesterId;
  if (value['tools'] !== undefined) turn.tools = parseTools(value['tools']);
  return turn;
}

function readRoutineTurn(value: Record<string, unknown>, turn: Turn) {
  if (value['senderAttemptId'] !== undefined) {
    turn.messageId = requiredString(value, 'messageId');
    turn.rootId = requiredString(value, 'rootId');
    turn.senderAttemptId = requiredString(value, 'senderAttemptId');
  }
}

function parseContextClass(value: unknown, executionMode: Turn['executionMode']) {
  if (value === undefined) return undefined;
  if (value !== 'shared_only' || executionMode !== 'restricted') {
    throw new Error('Invalid turn context class');
  }
  return value;
}

function parseExecutionMode(value: unknown) {
  if (value === undefined) return 'memory_free';
  if (value === 'restricted' || value === 'memory_free') return value;
  throw new Error('Invalid execution mode');
}

export function parseTools(value: unknown): ToolServer[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid tool list');
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > 48 * 1024) throw new Error('Tool list too large');
  return value.map(parseToolServer);
}

function parseToolServer(value: unknown): ToolServer {
  const server = record(value);
  checkFields(server, ['key', 'serverId', 'connectionId', 'serverInfo', 'definitions', 'modes']);
  const key = requiredString(server, 'key');
  const serverId = requiredString(server, 'serverId');
  const connectionId = requiredString(server, 'connectionId');
  if (!/^oc_[a-f0-9]{10}$/u.test(key)
    || !/^[\w-]{1,200}$/u.test(serverId) || !/^[\w-]{1,200}$/u.test(connectionId)) {
    throw new Error('Invalid tool server id');
  }
  const definitions: unknown = server['definitions'];
  if (!Array.isArray(definitions) || definitions.length > 1000
    || !definitions.every(isDefinition)) {
    throw new Error('Invalid tool definitions');
  }
  const modes: Record<string, 'allow' | 'ask'> = {};
  const suppliedModes = record(server['modes']);
  for (const [name, mode] of Object.entries(suppliedModes)) {
    if (!name || name.length > 200 || (mode !== 'allow' && mode !== 'ask')) throw new Error('Invalid tool mode');
    modes[name] = mode;
  }
  const toolServer: ToolServer = { key, serverId, connectionId, definitions, modes };
  if (server['serverInfo'] !== undefined) {
    const info = record(server['serverInfo']);
    checkFields(info, ['name', 'version']);
    const name = requiredString(info, 'name');
    const version = requiredString(info, 'version');
    if (name.length > 200 || version.length > 200) throw new Error('Invalid server information');
    toolServer.serverInfo = { name, version };
  }
  return toolServer;
}

function isDefinition(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768;
}

function checkFields(value: Record<string, unknown>, fields: string[]) {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error('Unknown tool field');
  }
}
