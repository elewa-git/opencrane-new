import { createHash } from 'node:crypto';
import type { connectionCustody, ConnectionStage } from '../../src/connection-custody.ts';
import type { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, history } from '../../src/actor.ts';
import { connectionOperationId } from '../../src/bearer-connections.ts';
import { oauthConfigurationDigest } from '../../src/oauth-attempt.ts';
import { toolPolicyFromRows } from '../../src/tool-policy.ts';

function declaration(name: string) {
  const definition = JSON.stringify({ name, inputSchema: { type: 'object' } });
  return { name, definition, revision: losslessJson(definition).digest,
    reviewed: false, costCents: 0 as const,
    review: { action: 'Read a record', consequence: 'Show the record',
      targetArgument: 'id', fields: ['id'], stepUp: false } };
}
function choice(tool: ReturnType<typeof declaration>) {
  return { name: tool.name, revision: tool.revision,
    reviewDigest: toolReviewDigest(tool), mode: 'allow' };
}

export async function oauthSelectionFixture(nats: Awaited<ReturnType<typeof natsFixture>>,
  userId: string, serverId: string, profileId = 'oauth',
  stageMaterial?: (stage: ConnectionStage) => ReturnType<ReturnType<typeof connectionCustody>['stage']>) {
  const subject = `connection-${userId}-${serverId}-${profileId}`;
  const serverSubject = `mcp-${serverId}`;
  const tools = ['read', 'write'].map(declaration);
  const choices = tools.map(choice);
  const now = Date.now();
  const locator = 'https://example.test/mcp';
  const hash = createHash('sha256');
  hash.update(JSON.stringify(locator));
  const endpointDigest = hash.digest('hex');
  const registered = envelope('test', serverSubject, 'mcp.server_registered',
    { serverId, kind: 'remote', locator, registeredBy: 'admin' });
  const discovered = envelope('test', serverSubject, 'mcp.server_discovered', {
    serverId, connectionId: 'installed', accountMode: 'personal', tools, toolCount: 2,
    schemaDigest: catalogueDigest(tools), checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(),
  });
  const existing = await nats.store.head(serverSubject);
  if (existing === 0) {
    await nats.seed([registered, discovered]);
  }
  const reviewed = envelope('test', serverSubject, 'mcp.server_reviewed', {
    serverId, connectionId: 'installed', accountMode: 'personal', tools: choices,
    catalogueDigest: catalogueDigest(tools), policyRevision: await nats.store.head(serverSubject),
    reviewedBy: 'admin',
  });
  reviewed.principal = { kind: 'human', id: 'admin' };
  const published = envelope('test', serverSubject, 'mcp.server_published',
    { serverId, publishedBy: 'admin' });
  if (existing === 0) {
    await nats.seed([reviewed, published]);
  }
  const rows = await history(nats.store, serverSubject, 'test');
  const policy = toolPolicyFromRows(rows);
  const configuration = { serverId, connectionId: 'installed', endpointDigest,
    policyRevision: policy.policyRevision, issuer: 'https://issuer.example.test/',
    consentEndpoint: 'https://issuer.example.test/consent',
    redirectUri: 'https://app.example.test/callback', clientId: 'client',
    protocolScopes: ['openid'], toolScopes: { read: ['read'], write: ['write'] } };
  const fields = { userId, serverId, connectionId: 'installed', profile: profileId };
  const appendUntil = now + 60_000;
  async function seed(type: string, data: object, eventId: string, commandId = eventId) {
    const event = envelope('test', subject, type, data, eventId);
    event.time = new Date(Date.now()).toISOString();
    event.source = 'opencrane-server';
    event.principal = { kind: 'human', id: userId };
    event.commandId = commandId;
    await nats.seed([event]);
    return nats.store.head(subject);
  }
  const attemptId = connectionOperationId('test', subject, 'consent');
  const identity = { secretRef: 'secret:synthetic', uid: 'uid', resourceVersion: '1' };
  const start = { ...fields, ...identity, attemptId, attemptDigest: 'a'.repeat(64),
    stateDigest: 'b'.repeat(64), expectedSequence: 0, appendUntil };
  const started = await seed('connection.oauth_started', start, attemptId, 'consent');
  const claimId = connectionOperationId('test', subject, `${attemptId}-exchange`);
  const claim = { ...fields, ...identity, attemptId, workerId: 'worker', purpose: 'consent',
    expectedSequence: started, appendUntil };
  const claimed = await seed('connection.oauth_exchange_claimed', claim, claimId);
  const resultId = connectionOperationId('test', subject, `${claimId}-result`);
  const operationId = connectionOperationId('test', subject, `${resultId}-confirm`);
  const activation = { connectionId: 'installed', ownerKind: 'personal', purpose: 'personal',
    generation: 1, uid: 'uid', resourceVersion: '1', endpointDigest, operationId,
    changedBy: userId, expectedSequence: claimed, appendUntil, reason: 'oauth_confirmed',
    configurationDigest: oauthConfigurationDigest(configuration),
    account: { issuer: configuration.issuer, subject: userId, scopes: ['openid', 'read'],
      expiresAt: now + 120_000 } };
  const saved = { userId, serverId, profile: profileId, secretRef: 'secret:synthetic', activation };
  if (stageMaterial) {
    const stage: ConnectionStage = { siloId: 'test', userId, serverId,
      profileId, purpose: 'personal', connectionId: 'installed', generation: 1,
      endpointDigest, operationId, expectedSequence: claimed, appendUntil };
    const staged = await stageMaterial(stage);
    if (!staged.identity) {
      throw new Error('Fixture custody unavailable');
    }
    saved.secretRef = `secret:${staged.identity.reference}`;
    activation.uid = staged.identity.uid;
    activation.resourceVersion = staged.identity.resourceVersion;
  }
  const revision = await seed('connection.created', saved, operationId, 'consent');
  function loadConfiguration() {
    return Promise.resolve(configuration);
  }
  const command = { action: 'select', serverId, connectionId: 'installed', profileId,
    profileRevision: revision, expectedSequence: 0, changeRef: 'choice' };
  return { subject, revision, configuration, loadConfiguration, command, saved, seed, fields };
}
