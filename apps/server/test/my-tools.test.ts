import { randomUUID } from 'node:crypto';
import { changeConnectionSelection, savePersonalKey } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { connectMcpCatalogue } from '@opencrane/projections';
import { expect, it, onTestFinished } from 'vitest';
import { buildServer } from '../src/server.ts';
import { integrationSessionHeaders } from './support/integration-session.ts';
import { personalKeyFixture } from './support/personal-key.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const headers = integrationSessionHeaders(config);

async function memberToolList() {
  const runtime = await fixture();
  onTestFinished(runtime.close.bind(runtime));
  const setup = await personalKeyFixture(runtime);
  const policy = await setup.publish();
  await setup.project();
  await setup.grant('alice');

  if (!runtime.databaseUrl) throw new Error('Missing fixture database URL');
  const catalogue = connectMcpCatalogue(runtime.databaseUrl);
  onTestFinished(catalogue.close);
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const memberReads = { silo: 'test', binding: setup.binding, store: setup.nats.store,
    db: setup.db, feed: { memberId } };
  const app = buildServer(config, { memberReads, integrations: { ...memberReads, catalogue } });
  async function closeApp() {
    await app.close();
  }
  onTestFinished(closeApp);

  const url = '/api/my/tools';
  const anonymous = await app.inject({ url });
  expect(anonymous.statusCode).toBe(401);
  const wrongOrganisation = await app.inject({ url, headers: headers('alice', 'foreign') });
  expect(wrongOrganisation.statusCode).toBe(403);
  const inactive = await app.inject({ url, headers: headers('missing') });
  expect(inactive.statusCode).toBe(403);
  const otherMemberQuery = await app.inject({ url: url + '?memberId=alice', headers: headers('bob') });
  expect(otherMemberQuery.statusCode).toBe(400);
  const adminRead = await app.inject({ url: '/api/org/integrations', headers: headers('alice') });
  expect(adminRead.statusCode).toBe(403);

  async function status(member: string, state: string, canManageConnection: boolean) {
    const reply = await app.inject({ url, headers: headers(member) });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toEqual({ rows: [{
      serverId: setup.serverId, name: 'OpenCrane demo', status: state, canManageConnection,
    }] });
  }

  await status('bob', 'unavailable', false);
  await status('alice', 'needs_account', true);
  await selectVerifiedKey(setup, policy.connectionId!);
  await status('alice', 'ready', true);
  await setup.grant('bob');
  await status('bob', 'needs_account', true);
  await setup.grant('alice', 'member', 'revoke');
  await status('alice', 'unavailable', false);
}

async function selectVerifiedKey(setup: Awaited<ReturnType<typeof personalKeyFixture>>,
  connectionId: string) {
  function stage() {
    return Promise.resolve({ status: 'staged' as const, identity: {
      reference: 'fixture', uid: 'fixture', resourceVersion: '1',
    } });
  }
  const dependencies = { custody: { stage }, db: setup.db, network: setup.remote.network };
  const command = { action: 'create' as const, serverId: setup.serverId, connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const input = { command, material: setup.accounts[0].key };
  const saved = await savePersonalKey(setup.nats.store, setup.binding, 'alice', dependencies, input);
  const selection = { action: 'select' as const, serverId: setup.serverId, connectionId,
    profileId: 'personal', profileRevision: saved.sequence, expectedSequence: 0,
    changeRef: randomUUID() };
  await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', selection);
}

it('lists only the signed-in member’s access and connection status', memberToolList, 120_000);
