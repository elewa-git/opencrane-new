import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { encodeSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { envelope } from '@opencrane/models';
import { computers, conversations, members, routines,
  type ProjectionRunner } from '@opencrane/projections';
import { memberDepartureSchema } from '@opencrane/protocol';
import { expect } from 'vitest';
import type { GroupOptions } from '../../src/members/group-routes.ts';

export async function reviewedRemoval(app: FastifyInstance, config: AuthConfig,
  options: GroupOptions, runner: ProjectionRunner, memberId = 'alice') {
  const actor = 'removal-admin';
  const subject = `member-${actor}`;
  const invitationId = randomUUID();
  const invitation = { memberId: actor, invitationId, email: 'admin@example.test',
    role: 'admin', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: actor } };
  const join = { memberId: actor, invitationId, email: 'admin@example.test',
    role: 'admin', displayName: 'Removal admin' };
  const auth = memberAuthorisation(options.binding);
  for (const [type, data] of [['member.invited', invitation], ['member.joined', join]] as const) {
    const event = envelope(options.silo, subject, type, data);
    event.principal = { kind: 'human', id: actor };
    const command = { event, expectedSequence: await options.store.head(subject) };
    expect((await options.store.append(command)).status).toBe('appended');
    if (type === 'member.joined') await auth.handler.handle(event, options.db);
  }
  await runner.initialise(routines);
  for (const projection of [members, conversations, computers, routines]) await runner.run(projection);
  const session = { sub: actor, orgId: config.expectedOrgId!, roles: [],
    authTime: Math.floor(Date.now() / 1000), exp: 2000000000 };
  const headers = { origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    'content-type': 'application/json' };
  const reviewRequest = { url: `/api/members/${memberId}/departure`, headers };
  const review = await app.inject(reviewRequest);
  expect(review.statusCode, review.body).toBe(200);
  const departure = memberDepartureSchema.parse(review.json());
  expect(departure.complete).toBe(true);
  const payload = { commandId: randomUUID(), expectedSequence: departure.memberSequence,
    reviewRevision: departure.reviewRevision };
  async function remove() {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No HTTP port');
    const request = { method: 'POST', headers, body: JSON.stringify(payload) };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/members/${memberId}/remove`,
      request);
    expect(response.status, await response.text()).toBe(200);
  }
  return remove;
}
