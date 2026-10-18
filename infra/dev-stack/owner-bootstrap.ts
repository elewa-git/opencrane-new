import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { connectEventStore, type StoredEvent } from '@opencrane/event-store';
import { getEventDefinition, memberInvitedDataSchema, memberJoinedDataSchema, parseEventByType } from '@opencrane/events';
import { memberAuthorisation } from '@opencrane/authz';
import { readEnv, root } from './config.ts';

// Create the development owner when a fresh local stack has no owner yet.
const memberId = 'jente-rosseel';
const email = 'jente@elewa.ke';
const invitationId = 'invite-jente-rosseel';
const settings = await readEnv('settings');
const oidc = JSON.parse(await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8')) as {
  extraIdentities: Array<{ issuer: string; subject: string }>;
};
assert(oidc.extraIdentities.length === 1, 'Dev owner identity is not configured');
// Link a packaged test owner to its own sign-in account. Keep the existing person untouched.
const identity = { ...oidc.extraIdentities[0]!,
  subject: process.env['PACKAGE_OWNER_SUBJECT'] ?? oidc.extraIdentities[0]!.subject };
const binding = await readEnv('binding');
const events = await connectEventStore(await readEnv('command'));
const authz = memberAuthorisation({ silo: settings['SILO_ID']!, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!, authorizationModelId: binding['OPENFGA_MODEL_ID']! });
const pool = new Pool({ connectionString: (await readEnv('projection'))['DATABASE_URL']! });

async function append(type: string, expectedSequence: number, data: Record<string, unknown>) {
  const id = randomUUID();
  const parsed = parseEventByType({ id, commandId: `dev-owner-bootstrap-${type}`, type,
    source: 'dev-stack-owner-bootstrap', time: new Date().toISOString(), subject: `member-${memberId}`,
    silo: settings['SILO_ID']!, principal: { kind: 'human', id: identity.subject }, data });
  assert(parsed.success && getEventDefinition(type));
  const result = await events.store.append({ event: parsed.event, expectedSequence });
  assert(result.status === 'appended', `Bootstrap append failed: ${result.status}`);
  return result.sequence;
}
async function member() {
  const result = await pool.query<{ member_id: string; role: string; status: string }>(`SELECT m.member_id, m.role, m.status
    FROM member_identities i JOIN members m USING (silo, member_id)
    WHERE i.silo = $1 AND i.issuer = $2 AND i.sub = $3`, [settings['SILO_ID'], identity.issuer, identity.subject]);
  return result.rows[0];
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for dev owner bootstrap');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  const seedSequence = await events.store.head(`ownership-${settings['SILO_ID']!}`);
  assert.equal(seedSequence, 0, 'Dev owner bootstrap is refused after ownership seeding');
  const history: StoredEvent[] = [];
  for await (const stored of events.store.readStream(`member-${memberId}`)) history.push(stored);
  assert(history.length <= 2, 'Dev owner member stream has unexpected events');
  let expectedSequence = history.at(-1)?.sequence ?? 0;
  if (history[0]) {
    const invited = memberInvitedDataSchema.parse(history[0].event.data);
    assert(history[0].event.type === 'member.invited' && history[0].event.principal?.id === identity.subject
      && invited.memberId === memberId && invited.email === email && invited.role === 'owner'
      && invited.invitedBy === 'dev-only-bootstrap'
      && invited.invitationId === invitationId && invited.invitedIdentity?.issuer === identity.issuer
      && invited.invitedIdentity.sub === identity.subject, 'Dev owner invitation differs from bootstrap');
  } else {
    expectedSequence = await append('member.invited', 0, { memberId, email, role: 'owner', invitedBy: 'dev-only-bootstrap', invitationId,
      invitedIdentity: { issuer: identity.issuer, sub: identity.subject }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  }
  if (history[1]) {
    const joined = memberJoinedDataSchema.parse(history[1].event.data);
    assert(history[1].event.type === 'member.joined' && history[1].event.principal?.id === identity.subject
      && joined.memberId === memberId && joined.email === email && joined.displayName === 'Jente Rosseel'
      && joined.role === 'owner' && joined.invitationId === invitationId,
    'Dev owner join differs from bootstrap');
  } else {
    await append('member.joined', expectedSequence, { memberId, invitationId, displayName: 'Jente Rosseel', email, role: 'owner' });
  }
  await waitFor(async () => {
    const row = await member();
    return row?.status === 'joined' && row.role === 'owner';
  });
  await waitFor(async () => (await authz.check(memberId, 'owner')).allowed);
  const row = await member();
  console.log(`PASS dev-only owner bootstrap: ${row?.member_id} ${row?.role}; OpenFGA owner=true`);
} finally {
  await pool.end();
  await events.close();
}
