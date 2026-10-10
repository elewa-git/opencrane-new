import { isToolCallText } from '@opencrane/events/tool-call';
import { createHash } from 'node:crypto';
import { record } from './http.ts';
import type { BridgeReport } from './report-journal.ts';
import type { Turn } from './turn-frame.ts';

function toolReport(input: Turn, item: Record<string, unknown>, finished: boolean) {
  if (input.executionMode === 'restricted' || item['type'] !== 'mcpToolCall') return;
  function hasServerKey(server: NonNullable<Turn['tools']>[number]) {
    return server.key === item['server'];
  }
  const server = input.tools?.find(hasServerKey);
  const callId = item['id'];
  const toolName = item['tool'];
  if (!server || !isToolCallText(callId) || !isToolCallText(toolName)) {
    return;
  }
  // Keep arguments, results and Codex error text out of the saved report.
  const report: Partial<BridgeReport> = { callId, serverId: server.serverId, toolName };
  if (finished) {
    report.status = 'failed';
    if (item['status'] === 'completed') report.status = 'completed';
    const durationMs = item['durationMs'];
    if (typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0) {
      report.durationMs = durationMs;
    }
  }
  return report;
}

export function itemReport(input: Turn, params: Record<string, unknown>, method: unknown,
  requestId?: unknown, codexTurnId?: string) {
  if (method === 'mcpServer/elicitation/request') {
    const data = nativeConsentReport(input, params, requestId, codexTurnId);
    if (data) return { type: 'agent.native_consent_refused', data };
    return;
  }
  if (method !== 'item/started' && method !== 'item/completed') return;
  const item = record(params['item']);
  const finished = method === 'item/completed';
  const toolData = toolReport(input, item, finished);
  if (toolData) {
    let type = 'agent.tool_call_started';
    if (finished) type = 'agent.tool_call_finished';
    return { type, data: toolData };
  }
  if (!finished) return;
  const command = item['command'];
  const exitCode = item['exitCode'];
  if (input.executionMode !== 'restricted' && item['type'] === 'commandExecution'
    && typeof command === 'string' && typeof exitCode === 'number') {
    const commandHash = createHash('sha256');
    commandHash.update(command);
    const commandDigest = commandHash.digest('hex');
    return { type: 'agent.command_ran', data: { commandDigest, exitCode } };
  }
  if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
    return { type: 'agent.message_completed', data: {
      messageId: String(item['id']), text: item['text'],
    } };
  }
  return;
}

function nativeConsentReport(input: Turn, params: Record<string, unknown>,
  requestId: unknown, codexTurnId: string | undefined) {
  if (params['turnId'] !== undefined && params['turnId'] !== null &&
      params['turnId'] !== codexTurnId) return;
  if (typeof requestId !== 'string' && !Number.isSafeInteger(requestId)) return;
  const nativeRequestId = String(requestId);
  const serverName = params['serverName'];
  if (!isToolCallText(nativeRequestId) || !isToolCallText(serverName)) return;
  function namesServer(server: NonNullable<Turn['tools']>[number]) {
    return server.key === serverName;
  }
  const server = input.tools?.find(namesServer);
  const data: Partial<BridgeReport> = { nativeRequestId, serverName,
    reason: 'unsupported_native_consent' };
  if (server) data.serverId = server.serverId;
  return data;
}
