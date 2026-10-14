import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { currentMembership, readActiveMember, MemberAccessRefused } from '@opencrane/models';
import { memberHeaderSchema, memberPageQuerySchema, memberDetailSchema,
  memberDirectorySchema } from '@opencrane/protocol';
import { registerToolExplanation } from '../integrations/explanation-routes.ts';
import { registerMemberInventory } from './inventory-routes.ts';
import { memberCounts } from './read-counts.ts';
import type { GroupOptions } from './group-routes.ts';
import { sessionFor } from './routes.ts';

const parameters = z.object({ memberId: z.string().regex(/^[\w-]{1,200}$/u).optional() });

class InvalidMemberRequest extends Error {
  constructor(error: z.ZodError) {
    super('Invalid member request', { cause: error });
  }
}

export function registerMemberReads(app: FastifyInstance, config: AuthConfig,
  options?: GroupOptions) {
  registerMemberInventory(app, config, options);
  registerToolExplanation(app, config, options);
  app.get('/api/members', handler);
  app.get('/api/members/:memberId', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    if (!trustedRead(config, options, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    function expire() {
      if (!reply.sent) void reply.code(503).send({ status: 'unavailable' });
    }
    const watchdog = setTimeout(expire, 10_000);
    try {
      const { memberId } = parseRequest(parameters, request.params);
      let query: z.infer<typeof memberPageQuerySchema> | undefined;
      if (!memberId) query = parseRequest(memberPageQuerySchema, request.query);
      const caller = await options.feed.memberId(options.silo, config.issuerUrl, session.sub);
      if (!caller) throw new MemberAccessRefused('Active membership required');
      const membership = await currentMembership(options.store, options.silo, caller);
      const management = isManager(membership.role);
      requireDirectoryRole(memberId, management);
      let requiredRole: 'member' | 'admin' = 'member';
      if (management) requiredRole = 'admin';
      await readActiveMember(options.store, options.binding, caller, requiredRole);
      if (!memberId) {
        const directory = await readDirectory(options, query);
        if (reply.sent) return reply;
        return reply.send(memberDirectorySchema.parse(directory));
      }
      const response = await readHeader(options, memberId, management, membership.role);
      if (reply.sent) return reply;
      return reply.code(response.code).send(response.body);
    } catch (error) {
      if (reply.sent) return reply;
      let code = 503;
      if (error instanceof InvalidMemberRequest) code = 400;
      if (error instanceof MemberAccessRefused) code = 403;
      return reply.code(code).send({ status: code === 503 ? 'unavailable' : 'refused' });
    } finally {
      clearTimeout(watchdog);
    }
  }
}

function parseRequest<T>(schema: z.ZodType<T>, input: unknown) {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) throw new InvalidMemberRequest(error);
    throw error;
  }
}

async function directoryRow(options: GroupOptions, memberId: string,
  membership: Awaited<ReturnType<typeof currentMembership>>) {
  const result = await options.db.query<{ email: string; display_name: string | null }>(
    'SELECT email, display_name FROM members WHERE silo = $1 AND member_id = $2',
    [options.silo, memberId]);
  const member = result.rows[0];
  function isJoin(row: (typeof membership.facts)[number]) {
    return row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped';
  }
  const joins = membership.facts.filter(isJoin);
  const joinedAt = joins.at(-1)?.event.time;
  if (!member || !joinedAt) throw new Error('Member content unavailable');
  const groups = await options.db.query<{
    groupId: string; name: string; membershipSource: string;
  }>(`SELECT g.group_id AS "groupId", g.name, m.membership_source AS "membershipSource"
    FROM group_members m JOIN groups g USING (silo, group_id)
    WHERE m.silo = $1 AND m.member_id = $2 ORDER BY g.group_id LIMIT 101`,
  [options.silo, memberId]);
  if (groups.rows.length > 100) throw new Error('Member groups exceed read limit');
  return { memberId, displayName: member.display_name, email: member.email,
    role: membership.role, status: 'joined' as const, joinedAt, groups: groups.rows };
}

async function readDirectory(options: GroupOptions,
  input: z.infer<typeof memberPageQuerySchema> | undefined) {
  if (!input) throw new Error('Directory query was not parsed');
  const result = await options.db.query<{ member_id: string }>(
    `SELECT member_id FROM members WHERE silo = $1 AND status = 'joined' AND member_id > $2
      AND ($3 = '' OR strpos(lower(coalesce(display_name, '')), lower($3)) > 0
        OR strpos(lower(email), lower($3)) > 0) ORDER BY member_id LIMIT $4`,
    [options.silo, input.after, input.q, input.limit + 1]);
  const page = result.rows.slice(0, input.limit);
  const rows = [];
  for (const row of page) {
    const membership = await currentMembership(options.store, options.silo, row.member_id);
    if (membership.role) rows.push(await directoryRow(options, row.member_id, membership));
  }
  let next: string | null = null;
  if (result.rows.length > input.limit) next = page.at(-1)?.member_id ?? null;
  const checkedAt = new Date().toISOString();
  const totals = await memberCounts(options, checkedAt);
  return { rows, next, ...totals, checkedAt, permissions: { invite: true } };
}

async function readHeader(options: GroupOptions, memberId: string,
  management: boolean, callerRole: string) {
  const target = await currentMembership(options.store, options.silo, memberId);
  if (!target.role) return { code: 404, body: { status: 'not_found' } };
  const result = await options.db.query<{ display_name: string | null }>(
    'SELECT display_name FROM members WHERE silo = $1 AND member_id = $2',
    [options.silo, memberId]);
  if (!result.rows[0]) throw new Error('Member content unavailable');
  const permissions = { changeRole: false, remove: false, manageOwnership: false };
  const header = { memberId, displayName: result.rows[0].display_name, role: target.role,
    permissions };
  if (!management) return { code: 200, body: memberHeaderSchema.parse(header) };
  const record = await directoryRow(options, memberId, target);
  const memberSequence = await options.store.head(`member-${memberId}`);
  const ownershipSequence = target.ownership.at(-1)?.sequence ?? 0;
  const canManageTarget = target.role !== 'owner';
  const detail = { ...record, permissions: { changeRole: canManageTarget,
    remove: canManageTarget, manageOwnership: callerRole === 'owner' },
    memberSequence, ownershipSequence, personalAssistant: { status: 'unavailable' },
    rejoinedAt: { status: 'unavailable' } };
  return { code: 200, body: memberDetailSchema.parse(detail) };
}

function trustedRead(config: AuthConfig, options: GroupOptions,
  session: { sub: string; orgId: string }) {
  return isOrganisationSession(config, session) && options.silo === options.binding.silo;
}

function isManager(role: string) {
  return role === 'owner' || role === 'admin';
}

function requireDirectoryRole(memberId: string | undefined, management: boolean) {
  if (!memberId && !management) throw new MemberAccessRefused('Owner or Admin required');
}
