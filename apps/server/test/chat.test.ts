import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport, recordReports, reportPosition } from '../src/chat/reports.ts';
import { conversationKeys } from '../src/chat/keys.ts';

async function reservesProviderConversationPrefix() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/chat-provider-prefix-`);
  try {
    const keys = conversationKeys(directory);
    const context = { silo: 'test', memberId: 'alice' };
    const input = { id: 'create-reserved', conversationId: 'provider-primary',
      assistantId: 'assistant' };
    keys.provision(context.silo, input.conversationId);
    await expect(chatCommand(nats.store, keys, context, input)).rejects.toThrow();
    expect(await nats.store.head('conversation-provider-primary')).toBe(0);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('reserves the provider conversation prefix for verification accounting',
  reservesProviderConversationPrefix);

it('creates and posts with event-id retries, rejects changed retries, and stores only encrypted text', async () => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/chat-keys-`);
  try {
    const keys = conversationKeys(directory), conversationId = randomUUID();
    const context = { silo: 'test', memberId: 'alice' };
    keys.provision(context.silo, conversationId);
    const created = { id: randomUUID(), conversationId, assistantId: 'assistant' };
    expect((await chatCommand(nats.store, keys, context, created)).status).toBe('appended');
    expect((await chatCommand(nats.store, keys, context, created)).status).toBe('appended');
    const raw = await nats.connection.request('$JS.API.STREAM.MSG.GET.EVENTS', JSON.stringify({ seq: 1 }));
    const stored = raw.json<{ message: { data: string } }>();
    expect(JSON.parse(Buffer.from(stored.message.data, 'base64').toString()) as unknown).toMatchObject({ data: { mode: 'agent_session' } });
    const posted = { id: randomUUID(), conversationId, text: 'Hello computer' };
    expect((await chatCommand(nats.store, keys, context, posted)).status).toBe('appended');
    expect((await chatCommand(nats.store, keys, context, posted)).status).toBe('appended');
    await expect(chatCommand(nats.store, keys, context, { ...posted, text: 'different' })).rejects.toThrow('Id reused');
    const events = await chatHistory(nats.store, context.silo, conversationId);
    expect(events.map(r => r.event.type)).toEqual(['conversation.created', 'message.posted']);
    expect(JSON.stringify(events)).not.toContain('Hello computer');
    expect(keys.decrypt(context.silo, conversationId, events[1]!.event.data)).toBe('Hello computer');
  } finally { await nats.close(); await rm(directory, { recursive: true, force: true }); }
});

it('rebuilds conversation messages and report positions from NATS in real PostgreSQL', async () => {
  const { databases } = await import('@opencrane/authz/testing');
  const { pgDb, ProjectionRunner, conversations, readConversation } = await import('@opencrane/projections');
  const { createLogger } = await import('@opencrane/observability');
  const nats = await natsFixture(), dbs = await databases(), directory = await mkdtemp(`${tmpdir()}/chat-keys-`);
  try {
    const keys = conversationKeys(directory), conversationId = randomUUID(); keys.provision('test', conversationId);
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: randomUUID(), conversationId, assistantId: 'assistant' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: randomUUID(), conversationId, text: 'Hello computer' });
    const db = pgDb(dbs.queue), runner = new ProjectionRunner(db, nats.store, createLogger('chat-test', { level: 'silent' }));
    await runner.initialise(conversations); await runner.run(conversations);
    const posted = (await chatHistory(nats.store, 'test', conversationId))[1]!.event;
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, conversationId, turnId: posted.id, assistantId: 'assistant', type: 'agent.turn_started' };
    await expect(recordReport(nats.store, keys, context, { ...report, sequence: 2 })).rejects.toThrow('sequence gap');
    await recordReport(nats.store, keys, context, report);
    await recordReport(nats.store, keys, context, report); // Lost acknowledgement, repeated on a new server connection.
    await recordReport(nats.store, keys, context, { ...report, sequence: 2, type: 'agent.message_delta', messageId: 'reply', text: 'Hello back' });
    await recordReport(nats.store, keys, context, { ...report, sequence: 3, type: 'agent.message_completed', messageId: 'reply', text: 'Hello back' });
    await recordReport(nats.store, keys, context, { ...report, sequence: 4, type: 'agent.turn_completed' });
    await runner.run(conversations);
    const before = await readConversation(db, 'test', conversationId);
    expect(before.rows[0]?.data).toMatchObject({ mode: 'agent_session' });
    expect(before.rows.map(r => r.type)).toEqual(['conversation.created', 'message.posted', 'agent.turn_started', 'agent.message_delta', 'agent.message_completed', 'agent.turn_completed']);
    expect(keys.decrypt('test', conversationId, before.rows[1]!.data)).toBe('Hello computer');
    await runner.rebuild(conversations);
    expect((await readConversation(db, 'test', conversationId)).rows).toEqual(before.rows);
  } finally { await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('projects conversation access for participants only, including owners/admins, and revokes removed members', async () => {
  const { openfga } = await import('@opencrane/authz/testing');
  const { createStore, memberAuthorisation } = await import('@opencrane/authz');
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test'), auth = memberAuthorisation(binding);
    const apply = async (type: string, subject: string, data: unknown) => auth.handler.handle({ id: randomUUID(), type, subject,
      silo: 'test', time: new Date().toISOString(), source: 'test', correlation: {}, data }, { query: () => Promise.resolve({ rows: [] }) });
    for (const role of ['member', 'owner', 'admin']) await apply('member.joined', `member-${role}`,
      { memberId: role, email: `${role}@example.test`, displayName: role, role });
    await apply('conversation.created', 'conversation-chat', { conversationId: 'chat', assistantId: 'assistant', createdBy: 'member', mode: 'agent_session' });
    expect((await auth.conversation('member', 'chat', 'read')).allowed).toBe(true);
    expect((await auth.conversation('member', 'chat', 'post')).allowed).toBe(true);
    expect((await auth.conversation('admin', 'chat', 'read')).allowed).toBe(false);
    expect((await auth.conversation('owner', 'chat', 'post')).allowed).toBe(false);
    await apply('member.removed', 'member-member', { memberId: 'member', removedBy: 'owner' });
    expect((await auth.conversation('member', 'chat', 'read')).allowed).toBe(false);
  } finally { await fga.close(); }
}, 120_000);

it('rejects a concurrent conflicting report and only acknowledges the committed payload in real NATS', async () => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/report-race-`);
  try {
    const keys = conversationKeys(directory); keys.provision('test', 'race');
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create', conversationId: 'race', assistantId: 'assistant' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message', conversationId: 'race', text: 'Hello' });
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = { sequence: 1, conversationId: 'race', turnId: 'message', assistantId: 'assistant', type: 'agent.message_completed', messageId: 'reply' };
    // Hold both writers at the append boundary, after both have read the same history.
    let release!: () => void, arrived = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const append = nats.store.append.bind(nats.store), store = nats.store;
    vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      if (++arrived === 2) release(); await gate; return append(...args);
    });
    const results = await Promise.allSettled(['first', 'second'].map(text => recordReport(store, keys, context, { ...report, text })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex(r => r.status === 'fulfilled');
    const rows = await chatHistory(nats.store, 'test', 'race');
    expect(keys.decrypt('test', 'race', rows.at(-1)!.event.data)).toBe(['first', 'second'][winner]);
    await expect(recordReport(nats.store, keys, context, { ...report, text: ['second', 'first'][winner] })).rejects.toThrow('Report sequence reused');
  } finally { await nats.close(); await rm(directory, { recursive: true, force: true }); }
});

it('records immutable agent_session mode and refuses binding an assistant to a human mode', async () => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/chat-mode-`);
  try {
    const keys = conversationKeys(directory); keys.provision('test', 'mode');
    const context = { silo: 'test', memberId: 'alice' };
    const input = { id: 'create-mode', conversationId: 'mode', assistantId: 'assistant' };
    await chatCommand(nats.store, keys, context, input);
    expect((await chatHistory(nats.store, 'test', 'mode'))[0]?.event.data).toMatchObject({ mode: 'agent_session' });
    for (const mode of ['direct', 'group'] as const) {
      await expect(chatCommand(nats.store, keys, context, { ...input, mode })).rejects.toThrow();
    }
    expect(await nats.store.head()).toBe(1);
  } finally { await nats.close(); await rm(directory, { recursive: true, force: true }); }
});

it('closes a turn permanently even if its terminal report arrives before server admission', async () => {
  const { turnCommand } = await import('../src/chat/turns.ts');
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/turn-close-`);
  try {
    const keys = conversationKeys(directory); keys.provision('test', 'early');
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'created', conversationId: 'early', assistantId: 'assistant' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message', conversationId: 'early', text: 'Hello' });
    const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
    await nats.store.append({ expectedSequence: 0, event: { id: 'ready', commandId: 'ready', type: 'computer.ready', subject: 'computer-assistant', silo: 'test', source: 'test', principal: { kind: 'system', id: 'test' }, time: new Date().toISOString(), data: { assistantId: 'assistant', computerId: 'computer', generation: 1 } } });
    await turnCommand(nats.store, context, { conversationId: 'early', turnId: 'message', status: 'completed' });
    await expect(turnCommand(nats.store, context, { conversationId: 'early', turnId: 'message', threadId: 'forged', status: 'started' })).rejects.toThrow('Turn is closed');
  } finally { await nats.close(); await rm(directory, { recursive: true, force: true }); }
});

it('binds personal paying group at admission, keeps it on retries and refuses shared work without a group', async () => {
  const { turnCommand } = await import('../src/chat/turns.ts');
  const { BudgetActor, envelope, history } = await import('@opencrane/models');
  const { createStore, memberAuthorisation } = await import('@opencrane/authz');
  const { openfga, databases } = await import('@opencrane/authz/testing');
  const { pgDb, readEvents } = await import('@opencrane/projections');
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/turn-budget-`);
  const fga = await openfga();
  const dbs = await databases();
  const iam = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(iam);
  try {
    const actor = new BudgetActor(nats.store, 'test'); await actor.start(2000, 20000, 'personal-default');
    const joinedMember = envelope('test', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
    });
    await nats.store.append({ expectedSequence: 0, event: joinedMember });
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'team-sales', 'team.created', { teamId: 'sales', name: 'Sales', createdBy: 'alice' }) });
    const teamHead = (await history(nats.store, 'team-sales', 'test')).at(-1)!.sequence;
    await nats.store.append({ expectedSequence: teamHead, event: envelope('test', 'team-sales', 'team.member_added', { teamId: 'sales', memberId: 'alice', addedBy: 'alice' }) });
    const keys = conversationKeys(directory);
    for (const kind of ['personal', 'team'] as const) {
      const subject = `assistant-${kind}`;
      const assistant: { assistantId: string; ownerId: string; kind: string;
        payingGroupId?: string } = { assistantId: kind, ownerId: 'alice', kind };
      if (kind === 'team') {
        assistant.ownerId = 'sales';
        assistant.payingGroupId = 'sales';
      }
      const created = envelope('test', subject, 'assistant.created', assistant);
      await nats.store.append({ expectedSequence: 0, event: created });
      await nats.store.append({ expectedSequence: 0, event: envelope('test', `computer-${kind}`, 'computer.ready', { assistantId: kind, computerId: kind, generation: 1 }) });
      keys.provision('test', kind);
      await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: `create-${kind}`, conversationId: kind, assistantId: kind });
      await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: `message-${kind}`, conversationId: kind, text: 'Hello' });
    }
    for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
      if (auth.handler.eventTypes.includes(row.event.type)) {
        await auth.handler.handle(row.event, pgDb(dbs.queue));
      }
    }
    const teamContext = { silo: 'test', assistantId: 'team', computerId: 'team', binding: iam };
    const context = { silo: 'test', assistantId: 'personal', computerId: 'personal' };
    const input = { conversationId: 'personal', turnId: 'message-personal', threadId: 'thread', status: 'started' as const };
    expect(await turnCommand(nats.store, context, input)).toMatchObject({ payingGroupId: 'personal-default' });
    await actor.configure({ scope: 'global', ceilingCents: 20000, defaultPayingGroupId: 'new-default', setBy: 'alice' });
    expect(await turnCommand(nats.store, context, input)).toMatchObject({ payingGroupId: 'personal-default' });
    expect((await history(nats.store, 'computer-personal', 'test')).filter(r => r.event.type === 'computer.turn_started')).toHaveLength(1);
    await expect(turnCommand(nats.store, teamContext, { conversationId: 'team', turnId: 'message-team', threadId: 'team-thread', status: 'started', executionMode: 'restricted' })).rejects.toThrow('Paying group unavailable');
    keys.provision('test', 'team-selected');
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create-selected', conversationId: 'team-selected', assistantId: 'team', payingGroupId: 'sales' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message-selected', conversationId: 'team-selected', text: 'Hello' });
    const selected = await history(nats.store, 'conversation-team-selected', 'test');
    await auth.handler.handle(selected[0]!.event, pgDb(dbs.queue));
    expect(await turnCommand(nats.store, teamContext, { conversationId: 'team-selected', turnId: 'message-selected', threadId: 'selected-thread', status: 'started', executionMode: 'restricted' })).toMatchObject({ payingGroupId: 'sales' });
    await expect(chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create-selected', conversationId: 'team-selected', assistantId: 'team', payingGroupId: 'different' })).rejects.toThrow('Id reused');

  } finally {
    await fga.close();
    await dbs.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const batchRaces = [
  { split: false, changed: true },
  { split: true, changed: true },
  { split: true, changed: false },
];
async function checksConcurrentBatchOriginals(test: typeof batchRaces[number]) {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/batch-race-`);
  const release = Promise.withResolvers<void>();
  let pending: Promise<string> | undefined;
  try {
    const keys = conversationKeys(directory);
    keys.provision('test', 'race');
    const member = { silo: 'test', memberId: 'alice' };
    const created = { id: 'create', conversationId: 'race', assistantId: 'assistant' };
    const message = { id: 'message', conversationId: 'race', text: 'Hello' };
    await chatCommand(nats.store, keys, member, created);
    await chatCommand(nats.store, keys, member, message);
    const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const originals = [batchReport(1, 'first '), batchReport(2, 'middle '),
      batchReport(3, 'last')];
    const submitted = [...originals];
    if (test.changed) submitted[0] = batchReport(1, 'never saved ');
    const entered = Promise.withResolvers<void>();
    const append = nats.store.append.bind(nats.store);
    let held = false;
    async function holdFirstAppend(command: Parameters<typeof append>[0]) {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return append(command);
    }
    vi.spyOn(nats.store, 'append').mockImplementation(holdFirstAppend);
    pending = recordReports(nats.store, keys, context, submitted);
    await entered.promise;
    if (test.split) {
      await recordReports(nats.store, keys, context, originals.slice(0, 1));
      await recordReports(nats.store, keys, context, originals.slice(1));
    } else {
      await recordReports(nats.store, keys, context, originals);
    }
    release.resolve();
    if (test.changed) await expect(pending).rejects.toThrow('Report sequence reused');
    else await expect(pending).resolves.toBe('recorded');
    const rows = await chatHistory(nats.store, 'test', 'race');
    let text = '';
    for (const row of rows) {
      if (row.event.type === 'agent.message_delta') {
        text += keys.decrypt('test', 'race', row.event.data);
      }
    }
    expect(text).toBe('first middle last');
    expect(await reportPosition(nats.store, 'test', 'computer')).toBe(3);
  } finally {
    release.resolve();
    await Promise.allSettled(pending ? [pending] : []);
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function batchReport(sequence: number, text: string) {
  return { sequence, previousSequence: sequence - 1, conversationId: 'race',
    turnId: 'message', assistantId: 'assistant', type: 'agent.message_delta',
    messageId: 'reply', text };
}
it.each(batchRaces)(
  'checks every concurrent batch original in real NATS (split $split, changed $changed)',
  checksConcurrentBatchOriginals);
