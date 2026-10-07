import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { readActiveMember, MemberAccessRefused } from '@opencrane/models';
import { identityLookupInputSchema, identityLookupSchema } from '@opencrane/protocol';
import type { GroupOptions } from './group-routes.ts';
import { DirectoryOrganisationError, type zitadelDirectory } from './zitadel.ts';
import { sessionFor } from './routes.ts';
import { deriveAdmission } from './admission.ts';

export type IdentityOptions = Omit<GroupOptions, 'db'> & {
  directory: Pick<ReturnType<typeof zitadelDirectory>, 'search'>;
};
export function registerIdentityLookup(app: FastifyInstance, config: AuthConfig,
  options?: IdentityOptions) {
  app.post('/api/invitations/identity', { bodyLimit: 1024 }, handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const now = new Date();
    const session = sessionFor(request, config, now);
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (request.headers.origin !== new URL(config.redirectUri).origin
      || !config.expectedOrgId || session.orgId !== config.expectedOrgId) {
      return reply.code(403).send({ status: 'refused' });
    }
    const input = identityLookupInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    const deadline = performance.now() + 10_000;
    const signal = AbortSignal.timeout(10_000);
    function expire() {
      if (!reply.sent) void reply.code(503).send({ status: 'unavailable' });
    }
    const timer = setTimeout(expire, 10_000);
    try {
      if (options.silo !== options.binding.silo) throw new MemberAccessRefused('Wrong silo');
      const caller = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!caller) throw new MemberAccessRefused('Active membership required');
      await readActiveMember(options.store, options.binding, caller, 'admin');
      if (reply.sent) return reply;
      const result = await lookup(options, config, input.data.email, now, deadline, signal);
      if (reply.sent) return reply;
      return reply.send(identityLookupSchema.parse(result));
    } catch (error) {
      if (reply.sent) return reply;
      if (error instanceof DirectoryOrganisationError) {
        return reply.send({ status: 'other_organisation' });
      }
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
    }
  }
}
async function lookup(options: IdentityOptions, config: AuthConfig, email: string,
  now: Date, deadline: number, signal: AbortSignal) {
  const people = await options.directory.search(email, signal);
  if (!people.length) return { status: 'not_found' };
  if (people.length > 1) return { status: 'ambiguous' };
  const person = people[0]!;
  if (person.details.resourceOwner !== config.expectedOrgId) return { status: 'other_organisation' };
  if (!person.human) return { status: 'not_human' };
  if (person.state !== 'USER_STATE_ACTIVE') return { status: 'inactive' };
  const contact = person.human.email;
  if (contact.email !== email || !contact.isEmailVerified) return { status: 'unverified' };
  const admission = await deriveAdmission(options.store, options.silo, config.issuerUrl,
    person.id, now, deadline);
  if ('status' in admission) return admission;
  return { status: 'match', subject: person.id, displayName: person.human.profile.displayName,
    email: contact.email, ...admission, defaults: { role: 'member',
      personalAssistant: 'provision', expiresAfterDays: 7 } };
}
