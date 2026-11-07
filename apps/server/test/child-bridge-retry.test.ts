import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { grantStream } from '@opencrane/authz';
import { BudgetActor, history } from '@opencrane/models';
import { childRequestedDataSchema, computerTurnStartedDataSchema } from '@opencrane/events';
import { bridgeChannel, type PrivateSession } from '../../computer/test/server.ts';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { allocateChildRoot } from '../src/chat/child-root.ts';
import { addChildFirstInput, createRequestedChild, requestChild }
  from '../src/chat/child-requests.ts';
import { startRecordedChild } from '../src/chat/child-start.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { startDecision } from '@opencrane/models';
import { summonFixture } from './support/child-summon.ts';

afterEach(() => vi.restoreAllMocks());

type Failure = 'capacity' | 'service' | 'reply';

async function preservesPreparedChild(failure: Failure) {
  const context = await summonFixture();
  const actor = new BudgetActor(context.nats.store, 'test');
  const selected = { computerId: 'child-computer', generation: 1 };
  const computer = { ...selected, assistantId: 'helper' };
  const server = createServer();
  let link: Awaited<ReturnType<typeof connectBridge>> | undefined;
  let decision: Awaited<ReturnType<typeof startDecision>> | undefined;
  let channel: ReturnType<typeof bridgeChannel> | undefined;
  let closeSession: (() => void) | undefined;
  let available = failure !== 'service';
  let attempts = 0;
  let completedAttempts = 0;
  let lostReply = false;
  let nativeStarts = 0;
  try {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'helper']]) {
      await context.append(grantStream('model', 'gpt-6.1-sol'), 'grant.given',
        { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind, granteeId,
          grantedBy: 'alice' });
    }
    await context.append('computer-helper', 'computer.claimed',
      { ...computer, tokenId: 'token:child' }, false);
    await context.append('computer-helper', 'computer.ready',
      { ...computer, podUid: 'child-pod' }, false);
    await actor.start(10_000, 10_000, 'payer');
    const input = { ...await context.parent(), payingGroupId: 'payer',
      allowanceBoundCents: 1000 };
    const intent = await requestChild(context.options, 'alice', input);
    const saved = childRequestedDataSchema.parse(intent.event.data);
    const created = await createRequestedChild(context.options, 'alice', input);
    await context.auth.handler.handle(created.event, context.db);
    await addChildFirstInput(context.options, 'alice', input);
    await activateRequestedChild(context.options, 'alice', input, 1);
    const threadId = saved.firstInputId;
    const selection = { ...selected, threadId };
    if (failure === 'capacity') {
      await allocateChildRoot(context.options, actor, 'alice', input, 1, selection);
      await actor.configure({ scope: 'global', dailyCeilingCents: 0,
        ceilingCents: 0, setBy: 'alice' });
    }
    async function childStart(value: unknown) {
      attempts++;
      try {
        if (!available) throw new Error('Decision unavailable');
        return await startRecordedChild(context.options, actor, value);
      } finally {
        completedAttempts++;
      }
    }
    function requireLeader() { return Promise.resolve(); }
    const dispatch = { routes: [], requireLeader, childStart };
    const identity = { issuer: 'https://child.test/', jwks: context.tokens.jwks };
    decision = await startDecision(actor, identity, context.options.binding,
      0, undefined, undefined, dispatch);
    if (failure === 'reply') {
      const fetchOriginal = globalThis.fetch.bind(globalThis);
      async function loseFirstReply(input: string | URL | Request, init?: RequestInit) {
        const response = await fetchOriginal(input, init);
        let requestUrl: string;
        if (typeof input === 'string') requestUrl = input;
        else if (input instanceof URL) requestUrl = input.href;
        else requestUrl = input.url;
        if (requestUrl.endsWith('/child-start') && attempts === 1) {
          lostReply = true;
          throw new Error('Lost HTTP reply');
        }
        return response;
      }
      vi.spyOn(globalThis, 'fetch').mockImplementation(loseFirstReply);
    }
    function privateSession(): Promise<PrivateSession> {
      let finish!: () => void;
      const closed = new Promise<void>(function keepSession(resolve) { finish = resolve; });
      closeSession = finish;
      function rpc(method: string) {
        if (method === 'thread/start') {
          return Promise.resolve({ thread: { id: threadId, ephemeral: true,
            path: null, environments: [] } });
        }
        if (method === 'turn/start') nativeStarts++;
        return Promise.resolve({ turn: { id: 'native-child' } });
      }
      return Promise.resolve({ rpc, close: finish, closed });
    }
    function credential() {
      return { value: 'computer-pass', expiresAt: Date.now() + 60_000 };
    }
    function grant() { return Promise.resolve(); }
    function unexpectedRpc(): Promise<never> {
      throw new Error('Persistent native process must not run');
    }
    const journal = `${context.directory}/child-retry-journal`;
    channel = bridgeChannel(server, { journal, credential, grant, privateSession,
      rpc: unexpectedRpc });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing computer address');
    const connection = { url: `ws://127.0.0.1:${address.port}/bridge`,
      computerId: selected.computerId, assistantId: 'helper', generation: 1,
      bearer: 'computer-pass' };
    link = await connectBridge({ ...context.options, childStartUrl: decision.url },
      connection, context.tokens);
    const turn = { type: 'turn', id: saved.firstInputId,
      conversationId: saved.childConversationId, assistantId: 'helper', requesterId: 'alice',
      executionMode: 'restricted', sharingClass: 'shared_only', text: 'Child input',
      token: 'preparing', expiresAt: Date.now() + 60_000 };
    link.socket.send(JSON.stringify(turn));
    await until(() => completedAttempts >= 1 &&
      (failure !== 'reply' || lostReply), 20_000);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
    expect(nativeStarts).toBe(0);
    expect(await readFile(journal, 'utf8')).not.toContain('agent.turn_failed');
    if (failure === 'capacity') {
      await actor.configure({ scope: 'global', dailyCeilingCents: 10_000,
        ceilingCents: 10_000, setBy: 'alice' });
    }
    available = true;
    await until(() => nativeStarts === 1, 15_000);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await readFile(journal, 'utf8')).not.toContain('agent.turn_failed');
    const computerEvents = await history(context.nats.store, 'computer-helper', 'test');
    function startsThisChild(row: typeof computerEvents[number]) {
      if (row.event.type !== 'computer.turn_started') return false;
      const parsed = computerTurnStartedDataSchema.safeParse(row.event.data);
      return parsed.success && parsed.data.turnId === saved.firstInputId;
    }
    expect(computerEvents.filter(startsThisChild)).toHaveLength(1);
  } finally {
    link?.socket.terminate();
    closeSession?.();
    await channel?.close();
    server.close();
    await decision?.close();
    await context.close();
  }
}

it.each(['capacity', 'service', 'reply'] as const)(
  'retries a prepared child after %s failure without failing or repeating native work',
  preservesPreparedChild, 60_000);
