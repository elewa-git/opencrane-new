import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { MemberAccessRefused, readActiveMember, readConnectionSelection,
  requirePersonalConnectionAccess } from '@opencrane/models';
import { isToolPolicyAvailable } from '@opencrane/projections';
import { myToolsSchema, type MyTool, type IntegrationRow } from '@opencrane/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GroupOptions } from '../members/group-routes.ts';
import { sessionFor } from '../members/routes.ts';
import { logPersonalConnectionFailure, personalConnectionRefusal }
  from './personal-connection-failure.ts';
import { readOwnConnectionServers } from './profile-list.ts';
import type { IntegrationOptions } from './routes.ts';

const emptyQuery = z.strictObject({});
type Catalogue = IntegrationOptions['catalogue'];

export function registerMyTools(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions, catalogue?: Catalogue) {
  app.get('/api/my/tools', handler);

  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send(personalConnectionRefusal('no_session'));
    if (!isOrganisationSession(config, session)) {
      return reply.code(403).send(personalConnectionRefusal('wrong_organisation'));
    }
    if (options && options.silo !== options.binding.silo) {
      return reply.code(403).send(personalConnectionRefusal('wrong_silo'));
    }
    if (!options || !catalogue) {
      return reply.code(503).send(personalConnectionRefusal('unavailable', 'unavailable'));
    }
    if (!emptyQuery.safeParse(request.query).success) {
      return reply.code(400).send(personalConnectionRefusal('invalid_input'));
    }

    try {
      const memberId = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!memberId) throw new MemberAccessRefused('Active membership required');
      await readActiveMember(options.store, options.binding, memberId);
      const rows = await readMyTools(options, catalogue, memberId);
      return reply.send(myToolsSchema.parse({ rows }));
    } catch (error) {
      if (error instanceof MemberAccessRefused) {
        return reply.code(403).send(personalConnectionRefusal('access_required'));
      }
      logPersonalConnectionFailure(request, error, 'connection.list');
      return reply.code(503).send(personalConnectionRefusal('unavailable', 'unavailable'));
    }
  }
}

async function readMyTools(options: GroupOptions, catalogue: Catalogue, memberId: string) {
  const registered = catalogue.rows(options.silo);
  const ownConnections = readOwnConnectionServers(options.db, options.silo, memberId);
  const [servers, savedConnections] = await Promise.all([registered, ownConnections]);
  const rows: MyTool[] = [];
  for (const server of servers) {
    const availability = await toolAvailability(options, catalogue, memberId, server);
    // Keep the member's own revoke action reachable after access is removed.
    const hasSavedConnection = savedConnections.has(server.serverId);
    const canManageConnection = availability.canManageConnection || hasSavedConnection;
    rows.push({ serverId: server.serverId, name: displayName(server),
      status: availability.status, canManageConnection });
  }
  return rows;
}

function displayName({ name, serverId }: IntegrationRow) {
  if (/^[a-f0-9]{64}$/iu.test(name) && name.toLowerCase() === serverId) return 'Unnamed tool';
  return name;
}

const unavailable = { status: 'unavailable', canManageConnection: false } as const;

async function toolAvailability(options: GroupOptions, catalogue: Catalogue, memberId: string,
  server: IntegrationRow): Promise<Pick<MyTool, 'status' | 'canManageConnection'>> {
  if (server.status.kind !== 'ready' || server.toolsAllowed === 0) return unavailable;
  const policy = await catalogue.tools(options.silo, server.serverId);
  if (!isToolPolicyAvailable(policy) || !policy.connectionId) return unavailable;
  const { store, binding } = options;
  try {
    if (policy.accountMode === 'none') {
      await requirePersonalConnectionAccess(store, binding, memberId, server.serverId);
      return { status: 'ready', canManageConnection: false };
    }
    if (policy.accountMode === 'personal' && policy.identityTool) {
      const selectionOptions = { loadConfiguration: options.loadOAuthConfiguration,
        requireGrant: true };
      const selection = await readConnectionSelection(store, binding, memberId, server.serverId,
        selectionOptions);
      const status = selection.status === 'verified' ? 'ready' : 'needs_account';
      return { status, canManageConnection: true };
    }
    return unavailable;
  } catch (error) {
    // Keep a denied tool in the list without returning any account or grant details.
    if (error instanceof MemberAccessRefused) return unavailable;
    throw error;
  }
}
