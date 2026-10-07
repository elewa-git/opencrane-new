import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { readActiveMember, MemberAccessRefused } from '@opencrane/models';
import { invitationEmailInputSchema, invitationEmailSchema } from '@opencrane/protocol';
import type { GroupOptions } from './group-routes.ts';
import { sessionFor } from './routes.ts';

export type InvitationEmailOptions = Omit<GroupOptions, 'db'>;
export function registerInvitationEmail(app: FastifyInstance, config: AuthConfig,
  options?: InvitationEmailOptions) {
  const routeOptions = { bodyLimit: 1024 };
  app.post('/api/invitations/identity', routeOptions, handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const now = new Date();
    const session = sessionFor(request, config, now);
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (request.headers.origin !== new URL(config.redirectUri).origin
      || !isOrganisationSession(config, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    const input = invitationEmailInputSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
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
      const result = {
        status: 'confirmation_on_acceptance',
        email: input.data.email,
        message: 'The person is confirmed when they accept the invitation.',
      };
      return reply.send(invitationEmailSchema.parse(result));
    } catch (error) {
      if (reply.sent) return reply;
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send({ status: 'refused' });
      }
      const diagnostic = { operation: 'invitation.email' };
      request.log.error(diagnostic, 'Invitation email check unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
    }
  }
}
