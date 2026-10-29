import { createHash } from 'node:crypto';
import type { TurnSummary } from '@opencrane/auth';
import { envelope } from '@opencrane/models';
import { losslessJson } from '@opencrane/events/lossless-json';
import { memoryScopeId } from '@opencrane/projections';
import { buildPrivateTurnRememberTools, buildPrivateTurnCorrectTools,
  buildPrivateTurnForgetTools } from '../../src/chat/turn-tools.ts';
import { rememberTool, correctTool, forgetTool } from '../../src/memory/mcp.ts';

/** @public Called by the native Docker fixture. */
export { checkPrivateTurnTools } from '../../src/chat/turn-tools.ts';
const builders = { remember: buildPrivateTurnRememberTools,
  correct: buildPrivateTurnCorrectTools, forget: buildPrivateTurnForgetTools };
const definitions = { remember: rememberTool, correct: correctTool, forget: forgetTool };

type Operation = keyof typeof builders;
type Input = Parameters<typeof buildPrivateTurnRememberTools>[0];

/** @public Called by the native Docker fixture. */
export function writeOffer(operation: Operation) {
  const hash = createHash('sha256');
  hash.update('memory');
  const digest = hash.digest('hex');
  const definition = JSON.stringify(definitions[operation]);
  return [{ key: `oc_${digest.slice(0, 10)}`, serverId: 'memory', connectionId: 'server',
    serverInfo: { name: 'OpenCrane memory', version: '1' },
    definitions: [definition], modes: { [operation]: 'allow' } }];
}

/** @public Called by the native Docker fixture. */
export async function prepareWrite(callers: Input['callers'], caller: string,
  grant: NonNullable<Input['grant']>, operation: Operation) {
  // Supply synthetic evidence to test protocol handling while admission stays disabled.
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
  const definition = JSON.stringify(definitions[operation]);
  const revision = losslessJson(definition).digest;
  const state = { serverId: 'memory', connectionId: 'server', published: true,
    accountMode: 'none' as const, serverInfo: { name: 'OpenCrane memory', version: '1' },
    discoveryTools: [{ name: operation, revision, definition }],
    policyTools: [{ name: operation, revision, reviewed: true, costCents: 0, mode: 'allow' as const }] };
  function readServer() { return Promise.resolve(state); }
  function canUse() { return Promise.resolve(true); }
  const input = { runtime, qualification, silo: grant.silo,
    scopeId: memoryScopeId(grant.silo, 'person', grant.requesterId),
    requesterId: grant.requesterId, assistantId: grant.assistantId, baseMessageBytes: 100,
    readServer, canUse, turn, grant, caller, callers };
  return builders[operation](input);
}
