import { createHash } from 'node:crypto';
import type { TurnSummary } from '@opencrane/auth';
import { envelope, privateCallers } from '@opencrane/models';
import { losslessJson } from '@opencrane/events/lossless-json';
import { memoryScopeId } from '@opencrane/projections';
import * as assembly from '../../src/chat/turn-tools.ts';
import { recallTool, rememberTool, correctTool, forgetTool } from '../../src/memory/mcp.ts';

// Supply synthetic evidence only to exercise the disabled preparation contract.
export async function privateCatalogue(callers: ReturnType<typeof privateCallers>,
  caller: string, grant: Parameters<typeof assembly.buildPrivateTurnRecallTools>[0]['grant'],
  name: 'recall' | 'remember' | 'correct' | 'forget' = 'recall') {
  if (!grant) throw new Error('Missing fixture grant');
  const runtime = { sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
    environmentId: 'disposable-test-host' };
  const checks = { privateTurns: 'PASS', nativeRecall: 'PASS', requesterIsolation: 'PASS',
    sessionIsolation: 'PASS', invalidation: 'PASS', unrelatedActivity: 'PASS',
    stopReconnect: 'PASS', replacementReload: 'PASS', persistence: 'PASS' };
  const qualification = { ...runtime, result: 'PASS', checks };
  const data = { conversationId: grant.conversation, turnId: grant.turnId,
    threadId: grant.thread, requesterId: grant.requesterId, assistantId: grant.assistantId,
    computerId: grant.computerId, task: 'chat_turn', executionMode: 'restricted' };
  const event = envelope(grant.silo, `computer-${grant.assistantId}`, 'computer.turn_started', data);
  event.source = 'opencrane-server';
  const turn: TurnSummary = { hasStart: true, firstStart: { sequence: 1, event },
    firstClose: undefined };
  let definition = JSON.stringify(recallTool);
  if (name === 'remember') definition = JSON.stringify(rememberTool);
  if (name === 'correct') definition = JSON.stringify(correctTool);
  if (name === 'forget') definition = JSON.stringify(forgetTool);
  const reviewed = losslessJson(definition);
  const state: assembly.TurnToolServerState = { serverId: 'memory', connectionId: 'server',
    published: true, accountMode: 'none', serverInfo: { name: 'OpenCrane memory', version: '1' },
    discoveryTools: [{ name, revision: reviewed.digest, definition }],
    policyTools: [{ name, revision: reviewed.digest, reviewed: true, costCents: 0, mode: 'allow' }] };
  function readServer() { return Promise.resolve(state); }
  function canUse() { return Promise.resolve(true); }
  const input = { runtime, qualification, silo: grant.silo,
    scopeId: memoryScopeId(grant.silo, 'person', grant.requesterId),
    requesterId: grant.requesterId, assistantId: grant.assistantId, baseMessageBytes: 100,
    readServer, canUse, turn, grant, caller, callers };
  let tools;
  if (name === 'recall') tools = await assembly.buildPrivateTurnRecallTools(input);
  else if (name === 'remember') tools = await assembly.buildPrivateTurnRememberTools(input);
  else if (name === 'correct') tools = await assembly.buildPrivateTurnCorrectTools(input);
  else tools = await assembly.buildPrivateTurnForgetTools(input);
  return { tools, input };
}

export { checkPrivateTurnTools } from '../../src/chat/turn-tools.ts';

export function privateToolOffer(name: 'recall' | 'remember' | 'correct' | 'forget') {
  let definition: typeof recallTool | typeof rememberTool | typeof correctTool | typeof forgetTool;
  definition = recallTool;
  if (name === 'remember') definition = rememberTool;
  if (name === 'correct') definition = correctTool;
  if (name === 'forget') definition = forgetTool;
  const hash = createHash('sha256');
  hash.update('memory');
  const digest = hash.digest('hex');
  const key = `oc_${digest.slice(0, 10)}`;
  return [{ key, serverId: 'memory', connectionId: 'server',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    definitions: [JSON.stringify(definition)], modes: { [name]: 'allow' as const } }];
}
