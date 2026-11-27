import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { objectId, TupleClient } from '../../../libs/authz/src/client.ts';
import { controlDesktopAccess } from '../src/computers/takeover-desktop-access.ts';
import { viewFixture } from './support/view-fixture.ts';

type Fixture = Awaited<ReturnType<typeof viewFixture>>;

function open() {
  return Promise.resolve(new PassThrough());
}

async function createTeam({ append }: Fixture, groupId: string, applied = true) {
  const subject = `team-${groupId}`;
  await append(subject, 'team.created', { teamId: groupId, name: groupId, createdBy: 'alice' },
    applied);
  await append(subject, 'team.member_added', {
    teamId: groupId, memberId: 'alice', addedBy: 'alice',
  }, applied);
}

async function giveDesktop({ append }: Fixture, granteeId: string,
  granteeKind: 'team' | 'assistant' = 'team') {
  const resourceType = 'shared_desktop';
  const resourceId = 'desktop';
  const subject = grantStream(resourceType, resourceId);
  return append(subject, 'grant.given', {
    resourceType, resourceId, granteeId, granteeKind, grantedBy: 'alice',
  }, true);
}

function access(fixture: Fixture) {
  const options = { ...fixture, silo: 'test', store: fixture.nats.store };
  return controlDesktopAccess(options, 'alice', 'chat', 'desktop');
}

async function unconfirmedTeamDoesNotMaskAnotherTeam() {
  const fixture = await viewFixture(open);
  const auth = memberAuthorisation(fixture.binding);
  try {
    await createTeam(fixture, 'applying', false);
    await giveDesktop(fixture, 'applying');
    await createTeam(fixture, 'current');
    const valid = await giveDesktop(fixture, 'current');
    const allowed = await access(fixture);
    expect(allowed.receipts).toEqual([valid.id]);
    expect((await auth.controlDesktop('alice', 'chat', 'desktop', allowed.receipts)).allowed)
      .toBe(true);

    const { append } = fixture;
    await append('team-applying', 'team.member_removed', {
      teamId: 'applying', memberId: 'alice', removedBy: 'bob',
    });
    await append('team-current', 'team.member_removed', {
      teamId: 'current', memberId: 'alice', removedBy: 'bob',
    });
    await expect(allowed.fresh()).rejects.toThrow('Paying group authority changed');
    // Keep the old OpenFGA tuple to prove that the saved removal decides access.
    expect((await auth.team('alice', 'current')).allowed).toBe(true);
    await expect(access(fixture)).rejects.toThrow(/^Desktop access required$/u);
  } finally {
    await fixture.close();
  }
}
it('lets one current team grant control and refuses stale saved team access',
  unconfirmedTeamDoesNotMaskAnotherTeam, 30_000);

async function sameNamedAssistantCannotGrantMemberAccess() {
  const fixture = await viewFixture(open);
  try {
    await createTeam(fixture, 'alice');
    await giveDesktop(fixture, 'alice', 'assistant');
    await expect(access(fixture)).rejects.toThrow('Desktop access required');
  } finally {
    await fixture.close();
  }
}
it('keeps assistant grants apart from team and individual desktop grants',
  sameNamedAssistantCannotGrantMemberAccess, 30_000);

type Permission = 'chat read' | 'desktop use' | 'grant receipt';
async function withholdPermission(fixture: Fixture, permission: Permission, eventId: string) {
  const client = new TupleClient(fixture.binding);
  if (permission === 'grant receipt') {
    const receipt = { user: objectId('silo', 'test'), relation: 'applied',
      object: objectId('projection_event', 'test', eventId) };
    await client.write([], [receipt]);
  } else if (permission === 'desktop use') {
    const resource = objectId('resource', 'test', 'shared_desktop', 'desktop');
    const team = objectId('team', 'test', 'current');
    await client.write([], [{ user: `${team}#member`, relation: 'use', object: resource }]);
  } else {
    const conversation = objectId('conversation', 'test', 'chat');
    const alice = objectId('person', 'test', 'alice');
    await client.write([], [{ user: alice, relation: 'participant', object: conversation }]);
  }
}

async function checksOneOpenFgaControlCondition(permission: Permission) {
  const fixture = await viewFixture(open);
  const auth = memberAuthorisation(fixture.binding);
  try {
    await createTeam(fixture, 'current');
    const grant = await giveDesktop(fixture, 'current');
    const { receipts } = await access(fixture);
    expect(receipts).toEqual([grant.id]);
    expect((await auth.controlDesktop('alice', 'chat', 'desktop', receipts)).allowed).toBe(true);
    await withholdPermission(fixture, permission, grant.id);
    expect((await auth.conversation('alice', 'chat', 'read')).allowed)
      .toBe(permission !== 'chat read');
    expect((await auth.use('person', 'alice', 'shared_desktop', 'desktop')).allowed)
      .toBe(permission !== 'desktop use');
    expect(await auth.applied(grant.id)).toBe(permission !== 'grant receipt');
    const denied = await auth.controlDesktop('alice', 'chat', 'desktop', receipts);
    expect(denied).toMatchObject({ status: 'ok', allowed: false });
  } finally {
    await fixture.close();
  }
}
it.each(['chat read', 'desktop use', 'grant receipt'] as const)(
  'requires the OpenFGA %s independently for a team-only control grant',
  checksOneOpenFgaControlCondition, 30_000,
);
