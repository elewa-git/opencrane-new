import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { auditTrail, members, computers, conversations, files, pgDb, ProjectionRunner,
  connectMemberFeed } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope } from '@opencrane/models';
import { Client } from 'minio/dist/esm/minio.mjs';
import type { ChatOptions } from '../../src/chat/routes.ts';
import { buildServer } from '../../src/server.ts';
import { conversationKeys } from '../../src/chat/keys.ts';
import { testAuthConfig } from './test-auth-config.ts';

export async function childFixture() {
  const nats = await natsFixture();
  const dbs = await databases();
  const fga = await openfga();
  const directory = await mkdtemp(`${tmpdir()}/child-participants-`);
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
  const binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(binding);
  const keys = conversationKeys(directory);
  const runner = new ProjectionRunner(db, nats.store, createLogger('review'));
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const options: ChatOptions = { silo: 'test', store: nats.store, db, keys, binding, feed };
  const objects = new Client({ endPoint: '127.0.0.1' });
  function unusedScan(): Promise<'clean'> {
    throw new Error('Reads must not scan a file');
  }
  const app = buildServer(config, { chat: options, memberReads: options, files: { ...options, objects, scan: unusedScan } });
  async function append(subject: string, type: string, data: unknown, iam = true) {
    const event = envelope('test', subject, type, data);
    let actorId = 'alice';
    if (type === 'member.joined') actorId = subject.slice('member-'.length);
    event.principal = { id: actorId, kind: 'human' };
    // Seed saved history, including old participant subjects that commands now refuse.
    const savedHistory = [event];
    await nats.seed(savedHistory);
    if (iam) await auth.handler.handle(event, db);
    return event;
  }
  for (const memberId of ['alice', 'bob']) {
    await append(`member-${memberId}`, 'member.invited', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: memberId },
    }, false);
    await append(`member-${memberId}`, 'member.joined', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      displayName: memberId, role: 'member',
    });
  }
  await append('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
  });
  for (const projection of [members, conversations, computers, files, auditTrail]) {
    await runner.initialise(projection);
    await runner.run(projection);
  }
  function headers(memberId = 'alice') {
    const session = {
      sub: memberId, orgId: 'org-test', roles: [],
      authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
    };
    return {
      origin: new URL(config.redirectUri).origin,
      cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    };
  }
  async function close() {
    await app.close();
    await feed.close();
    await nats.close();
    await dbs.close();
    await fga.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { app, nats, db, keys, runner, headers, append, close,
    config, options, objects, feed, fga, auth, directory,
    databaseUrl: dbs.queue.options.connectionString! };
}

export async function childSession(context: Awaited<ReturnType<typeof childFixture>>,
  conversationId = 'child', options: { parentSource?: boolean } = {}) {
  const parentData = { conversationId: 'parent', createdBy: 'alice', mode: 'group',
    participantIds: ['alice', 'bob'] };
  const parent = await context.append('conversation-parent', 'conversation.created', parentData);
  const parentJoinPosition = await context.nats.store.head('conversation-parent');
  let sourceMessageId = 'hidden-source';
  let sourcePosition = parentJoinPosition + 1;
  if (options.parentSource) {
    context.keys.provision('test', 'parent');
    const encrypted = context.keys.encrypt('test', 'parent', 'The parent source message');
    const sourceData = { conversationId: 'parent', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...encrypted };
    const source = await context.append('conversation-parent', 'message.posted', sourceData, false);
    sourceMessageId = source.id;
    sourcePosition = await context.nats.store.head('conversation-parent');
  }
  const teamData = { teamId: 'child-team', name: 'Child assistant', createdBy: 'alice' };
  await context.append('team-child-team', 'team.created', teamData);
  const assistantData = { assistantId: 'child-assistant', kind: 'team', ownerId: 'child-team',
    payingGroupId: 'child-team' };
  await context.append('assistant-child-assistant', 'assistant.created', assistantData);
  context.keys.provision('test', conversationId);
  const initialJoins = [];
  for (const participantId of ['alice', 'bob']) {
    const join = { participantId, parentJoinEventId: parent.id, parentJoinPosition };
    initialJoins.push(join);
  }
  const childData = {
    conversationId, createdBy: 'alice', mode: 'agent_session', contextKind: 'shared_child',
    assistantId: 'child-assistant', payingGroupId: 'child-team', initialJoins,
    origin: { parentConversationId: 'parent', sourceMessageId,
      sourcePosition, intentEventId: 'hidden-intent',
      intentPosition: parentJoinPosition + 2, requestId: 'hidden-request',
      firstInputId: 'hidden-input' },
  };
  const creation = await context.append(`conversation-${conversationId}`,
    'conversation.created', childData);
  const encrypted = context.keys.encrypt('test', conversationId, 'Hello shared history');
  const messageData = { conversationId, authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...encrypted };
  await context.append(`conversation-${conversationId}`, 'message.posted', messageData, false);
  await context.runner.run(conversations);
  return creation;
}

