import { expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { fixture } from '../fixture.ts';
import { oauthSelectionFixture, selectPersonalFixture } from './oauth-selection.ts';
import { remoteFixture } from './remote-mcp.ts';
import { catalogue, prepare, reviewRestoration, publishRestoration,
  restorationDelivery, generationHeaders } from './mcp-dispatch.ts';
export { body, catalogue, tool, prepare, permit, send, reviewRestoration,
  publishRestoration, restorationDelivery, generationHeaders } from './mcp-dispatch.ts';

export async function publishedFixture(mode = 'allow', remote = false, declared = true,
  accountMode: 'none' | 'personal' = 'none') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup, 'remote', remote, declared, accountMode);
  await reviewRestoration(setup, 'review-generation', mode);
  const record = await publishRestoration(setup, 'publish-generation');
  const delivery = await restorationDelivery(setup);
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  expect(await delivery.observe()).not.toBeNull();
  const constants = generationHeaders(record);
  return { setup, headers, record, delivery, constants };
}

export async function selectedPersonalFixture(mode: 'allow' | 'ask' | 'block' = 'allow',
  material = 'alice-access') {
  const context = await publishedFixture(mode, true, true, 'personal');
  const { setup } = context;
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  setup.dispatchOptions.routes.length = 0;
  setup.dispatchOptions.remoteNetwork = remote.network;
  remote.revision(catalogue.schemaDigest);
  function stageMaterial() {
    const staged = { status: 'staged' as const,
      identity: { reference: 'alice-secret', uid: 'alice-uid', resourceVersion: '1' } };
    return Promise.resolve(staged);
  }
  const saved = await oauthSelectionFixture(setup.nats, 'alice', 'fixture',
    'alice-profile', stageMaterial, { locator: 'https://mcp.example.test/mcp',
      grantedScopes: ['openid', 'write'] });
  const selectionRevision = await selectPersonalFixture(setup.nats, saved);
  let materialReads = 0;
  function readAccessMaterial() {
    materialReads += 1;
    return Promise.resolve(material);
  }
  function accessMaterialReadCount() {
    return materialReads;
  }
  setup.dispatchOptions.credentialDispatch = {
    db: setup.db, custody: { readAccessMaterial },
    loadConfiguration: saved.loadConfiguration,
  };
  const claims = { ...setup.t, thread: context.headers['session-id'], turn: 'dispatch',
    personalSelections: [{ serverId: 'fixture', profileId: 'alice-profile',
      selectionRevision }] };
  const token = await setup.sign(claims, 'decision-service');
  const rawClaims: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  expect(rawClaims).toMatchObject({ personalSelections: claims.personalSelections });
  const headers = { ...context.headers, ...context.constants, 'x-turn-token': token };
  return { setup, remote, headers, saved, accessMaterialReadCount };
}

export function requestFromPermit(value: string) {
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  return z.object({ requestId: z.string() }).parse(decoded).requestId;
}
