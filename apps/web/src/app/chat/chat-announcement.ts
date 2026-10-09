import type { ChatRow } from '@opencrane/protocol';
import { isActiveTurn, type Turn } from './chat-state';

export function toolTransitionAnnouncement(
  added: boolean,
  conversationReady: boolean,
  row: ChatRow,
  turns: Turn[],
): string {
  if (!added || !conversationReady) return '';
  if (row.type !== 'agent.tool_call_started' && row.type !== 'agent.tool_call_finished') {
    return '';
  }
  const activeTurn = findActiveAgentTurn(turns, row.data.turnId);
  if (!activeTurn) return '';
  const toolName = findToolName(activeTurn, row);
  const callNumber = findToolCallNumber(activeTurn, row.data.callId);
  if (row.type === 'agent.tool_call_started') {
    if (callNumber) return `${toolName} call ${callNumber} started.`;
    return `${toolName} started.`;
  }
  return finishedToolAnnouncement(toolName, callNumber, row.data.status);
}

function findActiveAgentTurn(turns: Turn[], turnId: string | undefined): Turn | undefined {
  if (!turnId) return undefined;
  for (const turn of turns) {
    if (turn.id === turnId && turn.author === 'agent' && isActiveTurn(turn)) return turn;
  }
  return undefined;
}

function findToolName(turn: Turn, row: ChatRow): string {
  if (row.data.toolName) return row.data.toolName;
  if (!row.data.callId) return 'Tool call';
  for (const tool of turn.tools) {
    if (tool.callId === row.data.callId) return tool.label;
  }
  return 'Tool call';
}

function findToolCallNumber(turn: Turn, callId: string | undefined): number | undefined {
  if (!callId) return undefined;
  let callNumber = 0;
  for (const tool of turn.tools) {
    if (!tool.callId) continue;
    callNumber += 1;
    if (tool.callId === callId) return callNumber;
  }
  return undefined;
}

function finishedToolAnnouncement(
  toolName: string,
  callNumber: number | undefined,
  status: string | undefined,
): string {
  const callLabel = callNumber ? `${toolName} call ${callNumber}` : toolName;
  if (status === 'completed') return `${callLabel} completed.`;
  if (status === 'failed') return `${callLabel} failed.`;
  return `${callLabel} finished without a reported result.`;
}
