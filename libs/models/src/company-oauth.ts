import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import type { connectionCustody } from './connection-custody.ts';
import { history } from './actor.ts';
import { ownershipWriteAccess } from './authority.ts';
import { foldCompanyOptIn } from './company-opt-in.ts';
import { connectionServer } from './connection-server.ts';
import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { currentMembership } from './ownership.ts';
import { toolPolicyFromRows } from './tool-policy.ts';
import { oauthConfigurationDigest, oauthConfigurationSchema, prepareOAuthAttempt }
  from './oauth-attempt.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const sessionSchema = z.strictObject({ sessionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  memberRevision: z.int().positive() });
const inputSchema = z.strictObject({ serverId: id, connectionId: id, profileId: id, changeRef: id,
  registrationRevision: z.int().positive(), optInRevision: z.int().positive(),
  expectedSequence: z.literal(0) });
type Loader = (serverId: string) => unknown;
type Custody = Pick<ReturnType<typeof connectionCustody>, 'prepareAttempt'>;

async function loadPreparation(store: EventStore, silo: string, raw: unknown,
  rawSession: unknown, loadConfiguration: Loader) {
  try {
    const input = inputSchema.parse(raw);
    const session = sessionSchema.parse(rawSession);
    const deadline = performance.now() + 10_000;
    const subject = `connection-company:${input.serverId}:${input.profileId}`;
    const profile = await history(store, subject, silo, deadline);
    const serverSubject = `mcp-${input.serverId}`;
    const rows = await history(store, serverSubject, silo, deadline);
    const optInSubject = `connection-company-${input.serverId}`;
    const choices = await history(store, optInSubject, silo, deadline);
    const server = connectionServer(rows, input.connectionId, 'company');
    const installation = { silo, serverId: input.serverId, connectionId: input.connectionId,
      registrationRevision: input.registrationRevision };
    const optIn = foldCompanyOptIn(choices, installation);
    const configuration = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
    if (profile.length !== 0 || !server.available ||
        server.registrationRevision !== input.registrationRevision ||
        !optIn.enabled || optIn.sequence !== input.optInRevision) {
      return null;
    }
    return { input, session, subject, optInSubject, rows, configuration };
  } catch {
    // Defer preparation failures until the current admin permission decision.
    return null;
  }
}

async function currentServerExpiry(store: EventStore, silo: string,
  configuration: z.infer<typeof oauthConfigurationSchema>, deadline: number) {
  const rows = await history(store, `mcp-${configuration.serverId}`, silo, deadline);
  const server = connectionServer(rows, configuration.connectionId, 'company');
  const policy = toolPolicyFromRows(rows);
  // Accept renewed catalogue evidence only while the admitted policy remains available.
  if (!server.available || policy.policyRevision !== configuration.policyRevision) {
    return null;
  }
  return server.expiresAt;
}

/** Prepare a new silo-owned attempt privately. No account is saved or made usable. */
export async function prepareCompanyOAuthAttempt(store: EventStore, binding: Binding,
  custodianId: string, rawSession: unknown, custody: Custody, raw: unknown,
  loadConfiguration: Loader) {
  try {
    const loaded = await loadPreparation(store, binding.silo, raw, rawSession, loadConfiguration);
    const membership = await currentMembership(store, binding.silo, custodianId,
      undefined, performance.now() + 10_000);
    const options = { requiredRole: 'admin' as const, membership };
    await activeMember(store, binding, custodianId, options);
    if (!loaded || loaded.session.memberRevision !==
        membership.positions.get(`member-${custodianId}`)) {
      return { status: 'unknown' as const };
    }
    const { input, session, configuration, rows } = loaded;
    const context = { ...input, ...session, siloId: binding.silo,
      ownerKind: 'company', custodianId };
    const prepared = await prepareOAuthAttempt(custody, context, configuration, rows, 'company');
    if (prepared.status !== 'prepared') {
      return prepared;
    }
    // Compare the admitted membership after custody waits, without another permission decision.
    const fresh = await ownershipWriteAccess(store, membership.positions);
    const configurationDigest = oauthConfigurationDigest(configuration);
    let position = await store.head(undefined, fresh.deadline);
    while (true) {
      await fresh();
      const current = oauthConfigurationSchema.parse(await loadConfiguration(input.serverId));
      const serverExpiresAt = await currentServerExpiry(store, binding.silo,
        configuration, fresh.deadline);
      if (oauthConfigurationDigest(current) !== configurationDigest ||
          serverExpiresAt === null ||
          await store.head(loaded.subject, fresh.deadline) !== 0 ||
          await store.head(loaded.optInSubject, fresh.deadline) !== input.optInRevision) {
        return { status: 'unknown' as const };
      }
      const checked = await store.head(undefined, fresh.deadline);
      const expiresAt = Math.min(prepared.stage.appendUntil, serverExpiresAt);
      if (performance.now() >= fresh.deadline || !Number.isFinite(expiresAt) ||
          Date.now() >= expiresAt) {
        return { status: 'unknown' as const };
      }
      if (position === checked) {
        return prepared;
      }
      // Recheck small positions after concurrent events, keeping the original deadline.
      position = checked;
    }
  } catch (error) {
    if (error instanceof MemberAccessRefused) {
      throw error;
    }
    return { status: 'unknown' as const };
  }
}
