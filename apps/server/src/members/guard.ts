import type { FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { chatIdSchema } from '@opencrane/events';
import { chatAccess, ChatAccessApplying, isChatRefused, type ChatOptions }
  from '../chat/access.ts';
import { sessionFor } from './routes.ts';

export const idSchema = chatIdSchema;
type MemberOptions = Omit<ChatOptions, 'keys'>;
interface MemberChecks {
  write: boolean;
  conversationId?: string | undefined;
  allowApplying?: boolean;
}

type MemberStatus = 'refused' | 'access_applying' | 'unavailable';

export class MemberRefusal extends Error {
  readonly statusCode: 401 | 403 | 425 | 503;
  readonly status: MemberStatus;

  constructor(
    statusCode: 401 | 403 | 425 | 503,
    status: MemberStatus,
    options?: ErrorOptions,
  ) {
    super(status, options);
    this.name = 'MemberRefusal';
    this.statusCode = statusCode;
    this.status = status;
  }
}

export function sameOrigin(request: Pick<FastifyRequest, 'headers'>, config: AuthConfig) {
  const expectedOrigin = new URL(config.redirectUri).origin;
  return request.headers.origin === expectedOrigin;
}

// Check reads once here. Commands open their short write check after loading history.
export async function requireMember<Options extends MemberOptions>(
  request: FastifyRequest, reply: FastifyReply, config: AuthConfig,
  options: Options | undefined, checks: MemberChecks,
) {
  reply.header('cache-control', 'no-store');
  const session = sessionFor(request, config, new Date());
  if (!session) throw new MemberRefusal(401, 'refused');
  if (!options || !options.silo || !config.expectedOrgId) {
    throw new MemberRefusal(503, 'unavailable');
  }
  // Use the issuer-bound cookie and the same exact identity exceptions as sign-in.
  if (!isOrganisationSession(config, session) || options.silo !== options.binding.silo) {
    throw new MemberRefusal(403, 'refused');
  }
  if (checks.write && !sameOrigin(request, config)) throw new MemberRefusal(403, 'refused');
  try {
    const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
    if (!memberId) throw new MemberRefusal(403, 'refused');
    const relation = checks.write ? 'post' : 'read';
    const accessRequest = { memberId, conversationId: checks.conversationId, relation,
      allowApplying: checks.allowApplying ?? false } as const;
    const access = await chatAccess(options, accessRequest);
    return { session, memberId, options, access };
  } catch (error) {
    throwMemberRefusal(error);
  }
}

function throwMemberRefusal(error: unknown): never {
  if (error instanceof MemberRefusal) throw error;
  const cause = { cause: error };
  if (error instanceof ChatAccessApplying) {
    throw new MemberRefusal(425, 'access_applying', cause);
  }
  if (isChatRefused(error)) throw new MemberRefusal(403, 'refused', cause);
  throw new MemberRefusal(503, 'unavailable', cause);
}
