import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { conversationKeys } from '../../src/chat/keys.ts';
import type { LiveViewOptions } from '../../src/computers/view.ts';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { pgDb, connectMemberFeed, members, conversations, computers, ProjectionRunner } from '@opencrane/projections';
import type { LogDestination } from '@opencrane/observability';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../../src/server.ts';
import { testAuthConfig } from './test-auth-config.ts';


export async function viewFixture(
  open: LiveViewOptions['open'],
  redirectUri?: string,
  logDestination?: LogDestination,
) {
  const nats = await natsFixture(), dbs = await databases(), fga = await openfga();
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test', ...(redirectUri ? { redirectUri } : {}) };
  const binding = await createStore(fga.apiUrl, 'test'), auth = memberAuthorisation(binding), db = pgDb(dbs.queue);
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const runner = new ProjectionRunner(db, nats.store, createLogger('view-test', { level: 'silent' }));
  const append = async (subject: string, type: string, data: unknown, project = false) => {
    const event = envelope('test', subject, type, data); event.principal = { kind: 'human', id: type === 'member.joined' ? subject.slice('member-'.length) : 'alice' };
    // Seed saved history, including old participant subjects that commands now refuse.
    const savedHistory = [event];
    await nats.seed(savedHistory);
    if (project) await auth.handler.handle(event, db);
    return event;
  };
  const directory = await mkdtemp(`${tmpdir()}/view-keys-`), keys = conversationKeys(directory);
  const serverOptions = {
    ...(logDestination ? { logDestination } : {}),
    chat: { silo: 'test', store: nats.store, binding, feed, db, keys },
    liveView: { silo: 'test', store: nats.store, binding, feed, db, open },
  };
  const app = buildServer(config, serverOptions);
    await append('member-alice', 'member.invited', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' } });
    await append('member-alice', 'member.joined', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', displayName: 'Alice' }, true);
    await append('member-bob', 'member.invited', { memberId: 'bob', invitationId: 'invite-bob', email: 'b@example.test', role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: 'bob' } });
    await append('member-bob', 'member.joined', { memberId: 'bob', invitationId: 'invite-bob', email: 'b@example.test', role: 'member', displayName: 'Bob' }, true);
    await runner.initialise(members); await runner.run(members);
    await append('assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }, true);
    await append('conversation-chat', 'conversation.created', { conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' }, true);
    await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'desktop', sandboxUid: 'sandbox', generation: 1, tokenId: 'token:test' });
    await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'fixture' });
  await runner.initialise(conversations); await runner.run(conversations); await runner.initialise(computers); await runner.run(computers);
  return { app, config, append, nats, binding, fga, runner, db, feed, keys, close: async () => { await app.close(); await feed.close(); await nats.close(); await dbs.close(); await fga.close(); await rm(directory, { recursive: true, force: true }); } };
}
