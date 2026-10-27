import Fastify from 'fastify';
import { expect } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import { envelope } from '@opencrane/models';
import { connectMemberFeed, type Db } from '@opencrane/projections';
import type { natsFixture } from '@opencrane/event-store/testing';
import { registerFileRoutes } from '../../apps/server/src/files/routes.ts';
import { testAuthConfig } from '../../apps/server/test/support/test-auth-config.ts';
import type { seedRecoveryFiles } from './upgrade-recovery-files-fixture.ts';
import type { storageClient } from '../../apps/server/src/files/storage.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org' };
type Nats = Pick<Awaited<ReturnType<typeof natsFixture>>, 'store' | 'seed'>;

export async function seedRecoveryReader(nats: Nats) {
  for (const memberId of ['reader', 'foreign']) {
    const invitation = { memberId, invitationId: memberId, email: `${memberId}@example.test`,
      role: 'member', invitedBy: 'owner',
      invitedIdentity: { issuer: config.issuerUrl, sub: memberId } };
    const joined = { memberId, invitationId: memberId, email: `${memberId}@example.test`,
      role: 'member', displayName: memberId };
    const events = [
      envelope('test', `member-${memberId}`, 'member.invited', invitation),
      envelope('test', `member-${memberId}`, 'member.joined', joined),
    ];
    for (const event of events) event.principal = { kind: 'human', id: memberId };
    await nats.seed(events);
  }
  const assistant = { assistantId: 'file-assistant', ownerId: 'reader', kind: 'personal' };
  const conversation = { conversationId: 'file-chat', assistantId: 'file-assistant',
    createdBy: 'reader', mode: 'agent_session' };
  await nats.seed([
    envelope('test', 'assistant-file-assistant', 'assistant.created', assistant),
    envelope('test', 'conversation-file-chat', 'conversation.created', conversation),
  ]);
}

export async function checkRecoveryReads(nats: Nats, db: Db,
  objects: ReturnType<typeof storageClient>, binding: Binding,
  uploads: Awaited<ReturnType<typeof seedRecoveryFiles>>, transitions = false) {
  const database = await db.query<{ name: string }>('SELECT current_database() AS name');
  const address = new URL(process.env['PG_TEST_URL']!);
  address.pathname = `/${database.rows[0]!.name}`;
  const feed = await connectMemberFeed(address.href);
  const app = Fastify();
  function readOnly(request: { method: string }, reply: import('fastify').FastifyReply,
    done: () => void) {
    if (request.method !== 'GET') void reply.code(405).send();
    done();
  }
  async function scan(): Promise<() => 'clean'> {
    throw new Error('Recovery must not scan');
  }
  const options = { silo: 'test', store: nats.store, db, binding, feed, objects, scan };
  app.addHook('onRequest', readOnly);
  registerFileRoutes(app, config, options);
  async function read(sub: string, permitted: boolean) {
    const now = Math.floor(Date.now() / 1000);
    const session = { sub, orgId: 'org', roles: [], authTime: now, exp: now + 300 };
    const cookie = encodeSession(config, session);
    const headers = { cookie: `${config.cookieName}=${cookie}` };
    const url = '/api/conversations/file-chat/files';
    const list = await app.inject({ url, headers });
    if (permitted) {
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ rows: [
        { fileId: 'notes', status: 'delivered' }, { fileId: 'screen', status: 'uploaded' },
      ] });
    } else {
      expect(list.statusCode).toBe(403);
      expect(list.body).not.toContain('fileId');
    }
    for (const upload of uploads) {
      const path = `uploads/file-chat/${upload.data.fileId}/${upload.data.name}`;
      const view = await app.inject({ url: `${url}/view?path=${path}`, headers });
      expect(view.statusCode).toBe(permitted ? 200 : 403);
      if (permitted) expect(view.rawPayload).toEqual(upload.bytes);
      else expect(view.rawPayload.includes(upload.bytes)).toBe(false);
      expect(view.body).not.toContain(upload.data.objectKey);
    }
  }
  try {
    await read('reader', true);
    await read('foreign', false);
    options.silo = 'foreign';
    await read('reader', false);
    options.silo = 'test';
    if (transitions) {
      const activity = envelope('test', 'conversation-file-chat', 'agent.turn_started',
        { conversationId: 'file-chat', turnId: 'unrelated', assistantId: 'file-assistant' });
      await nats.seed([activity]);
      await read('reader', true);
      const removal = envelope('test', 'member-reader', 'member.removed',
        { memberId: 'reader', removedBy: 'owner' });
      await nats.seed([removal]);
      // Keep read tables and OpenFGA unchanged to check the current recorded removal.
      await read('reader', false);
    }
  } finally {
    await app.close();
    await feed.close();
  }
}
