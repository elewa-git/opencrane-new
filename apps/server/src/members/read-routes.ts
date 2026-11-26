import { memberJoinedDataSchema, recordIdSchema } from '@opencrane/events';
import { isEventStoreUnavailable } from '@opencrane/event-store';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { AuthorityApplying, currentMembership, readActiveMember,
  MemberAccessRefused } from '@opencrane/models';
import { memberHeaderSchema, memberPageQuerySchema, memberDetailSchema,
  memberDirectorySchema } from '@opencrane/protocol';
import { registerToolExplanation } from '../integrations/explanation-routes.ts';
import { readActiveIdentity, type MemberAccount } from './admission.ts';
import { registerMemberInventory } from './inventory-routes.ts';
import { memberCounts } from './read-counts.ts';
import type { GroupOptions } from './group-routes.ts';
import { sessionFor } from './routes.ts';

const parameters = z.object({ memberId: recordIdSchema.optional() });

class InvalidMemberRequest extends Error {
  constructor(error: z.ZodError) {
    super('Invalid member request', { cause: error });
  }
}

class MemberJoinApplying extends Error {}
class MemberPermissionsUnavailable extends Error {
  constructor(cause: Error) {
    super('IAM unavailable', { cause });
  }
}

const admissionWaitMs = 30_000;
const permissionErrorCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN',
]);

type Membership = Awaited<ReturnType<typeof currentMembership>>;

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
    if (!options) {
      request.log.error({ reason: 'dependencies_missing' }, 'Member read unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
    if (!trustedRead(config, options, session)) {
      return reply.code(403).send({ status: 'refused' });
    }
    let stage = 'request';
    function expire() {
      if (reply.sent) return;
      request.log.error({ stage, reason: 'deadline_exceeded' }, 'Member read unavailable');
      void reply.code(503).send({ status: 'unavailable' });
    }
    const watchdog = setTimeout(expire, 10_000);
    try {
      const { memberId } = parseRequest(parameters, request.params);
      let query: z.infer<typeof memberPageQuerySchema> | undefined;
      if (!memberId) query = parseRequest(memberPageQuerySchema, request.query);
      stage = 'caller_access';
      const account = { issuer: config.issuerUrl, sub: session.sub };
      const caller = await authoriseRead(options, account, memberId);
      if (!memberId) {
        stage = 'member_directory';
        const directory = await readDirectory(options, query, request.log);
        if (reply.sent) return reply;
        return reply.send(memberDirectorySchema.parse(directory));
      }
      stage = 'member_detail';
      const response = await readHeader(options, memberId, caller.management, caller.role);
      if (reply.sent) return reply;
      return reply.code(response.code).send(response.body);
    } catch (error) {
      if (reply.sent) return reply;
      if (error instanceof InvalidMemberRequest) return reply.code(400).send({ status: 'refused' });
      if (error instanceof MemberAccessRefused) return reply.code(403).send({ status: 'refused' });
      if (error instanceof MemberJoinApplying) {
        return reply.code(425).send({ status: 'access_applying' });
      }
      const reason = memberReadFailure(error);
      const diagnostic = permissionDiagnostic(error);
      request.log.error({ stage, reason, ...diagnostic }, 'Member read unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    } finally {
      clearTimeout(watchdog);
    }
  }
}

async function authoriseRead(options: GroupOptions, account: MemberAccount,
  targetId: string | undefined) {
  const { store, db, silo, binding } = options;
  const now = new Date();
  const identity = await readActiveIdentity(store, db, silo, account, now);
  if (identity.status !== 'active') {
    throw new MemberAccessRefused('Active membership required');
  }

  const caller = identity.memberId;
  const membership = await currentMembership(store, silo, caller);
  const management = isManager(membership.role);
  if (!targetId && !management) {
    throw new MemberAccessRefused('Owner or Admin required');
  }
  const admission = recentAdmission(membership, caller, now);
  if (!identity.projectedJoined) {
    // Trust a recent saved admission to ask for a wait while the member table is behind it.
    if (admission && admission.sequence > identity.projectedSequence) {
      throw new MemberJoinApplying();
    }
    throw new MemberAccessRefused('Active membership required');
  }

  const requiredRole = management ? 'admin' : 'member';
  const applied = await requireAdmissionApplied(options, admission, membership);
  const role = await readActiveMember(store, binding, caller, requiredRole, applied);
  return { role, management };
}

function recentAdmission(membership: Membership, caller: string, now: Date) {
  const subject = `member-${caller}`;
  function concernsCaller(row: Membership['facts'][number]) {
    return row.event.subject === subject;
  }
  const latest = membership.facts.findLast(concernsCaller);
  if (!latest) {
    return undefined;
  }
  const age = now.getTime() - Date.parse(latest.event.time);
  if (age < 0 || age >= admissionWaitMs) {
    return undefined;
  }
  if (latest.event.type === 'silo.owner_bootstrapped') {
    return latest;
  }
  // Treat only accepted invitations as new access. Older joins may lack an invitation.
  if (latest.event.type === 'member.joined') {
    const join = memberJoinedDataSchema.parse(latest.event.data);
    if (join.invitationId) {
      return latest;
    }
  }
  return undefined;
}

async function requireAdmissionApplied(options: GroupOptions,
  admission: ReturnType<typeof recentAdmission>, membership: Membership) {
  if (!admission) {
    return undefined;
  }
  const auth = memberAuthorisation(options.binding);
  const admissionId = admission.event.id;
  const receipt = await auth.checkApplied(admissionId);
  if (receipt.status === 'unavailable') {
    throw new MemberPermissionsUnavailable(receipt.error);
  }
  if (!receipt.allowed) {
    throw new MemberJoinApplying();
  }
  let ownerSeedId: string | undefined;
  if (admission.event.type === 'silo.owner_bootstrapped') {
    const seed = membership.ownership.find(isOwnershipSeed);
    ownerSeedId = seed?.event.id;
  }

  async function applied(eventId: string) {
    // Reuse only this receipt. Ownership and other changes have their own receipts.
    if (eventId === admissionId) {
      return true;
    }
    if (eventId !== ownerSeedId) {
      return auth.applied(eventId);
    }
    const seedReceipt = await auth.checkApplied(eventId);
    if (seedReceipt.status === 'unavailable') {
      throw new MemberPermissionsUnavailable(seedReceipt.error);
    }
    if (!seedReceipt.allowed) {
      throw new MemberJoinApplying();
    }
    return true;
  }
  return applied;
}

function isOwnershipSeed(row: Membership['ownership'][number]) {
  return row.event.type === 'ownership.seeded';
}

function permissionDiagnostic(error: unknown) {
  if (!(error instanceof MemberPermissionsUnavailable)) {
    return {};
  }
  // Log only recognised network codes or HTTP statuses. The cause may contain private URLs.
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth += 1) {
    const code: unknown = Reflect.get(cause, 'code');
    if (typeof code === 'string' && permissionErrorCodes.has(code)) {
      return { dependencyCode: code };
    }
    const status: unknown = Reflect.get(cause, 'statusCode');
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      return { dependencyStatus: status };
    }
    cause = cause.cause;
  }
  return { dependencyCode: 'unknown' };
}

function memberReadFailure(error: unknown) {
  // Dependency messages and validation issues can contain private data.
  if (isEventStoreUnavailable(error)) return 'event_store_unavailable';
  if (error instanceof AuthorityApplying) return 'membership_applying';
  if (error instanceof z.ZodError) return 'invalid_stored_data';
  if (error instanceof Error) {
    const code: unknown = Reflect.get(error, 'code');
    const severity: unknown = Reflect.get(error, 'severity');
    if (typeof severity === 'string' && typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code)) {
      return code;
    }
    if (error.message === 'IAM unavailable') return 'iam_unavailable';
    if (error.message === 'Members feed unavailable') return 'members_feed_unavailable';
    if (error.message === 'Query read timeout') return 'database_timeout';
    if (error.message === 'Member content unavailable') return 'member_content_unavailable';
    if (error.message === 'Member groups exceed read limit') return 'member_group_limit';
  }
  return 'unexpected_error';
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
  input: z.infer<typeof memberPageQuerySchema> | undefined, logger: FastifyBaseLogger) {
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
  const totals = await memberCounts(options, checkedAt, logger);
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
