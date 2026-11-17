import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history } from '@opencrane/models';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { captureCatalogue, ordinaryWrite, rejectedSibling } from './support/ordinary-catalogue.ts';

async function refusesUnversionedAppend(kind: 'discovery' | 'undated' | 'changed' | 'full-list') {
  const snapshot = await captureCatalogue([ordinaryWrite, rejectedSibling]);
  const nats = await natsFixture();
  try {
    const fresh = { ...event('fresh-v2', 'mcp-fixture', 'mcp.server_discovered'),
      time: new Date().toISOString(), data: snapshot };
    const appended = await nats.store.append({ event: fresh, expectedSequence: 0 });
    expect(appended.status).toBe('appended');
    const before = await history(nats.store, 'mcp-fixture', 'test');
    const downgraded = { ...snapshot, schemaDigest: catalogueDigest(snapshot.tools!) };
    Reflect.deleteProperty(downgraded, 'digestVersion');
    if (kind === 'full-list') {
      downgraded.schemaDigest = snapshot.schemaDigest;
    }
    if (kind === 'undated') {
      Reflect.deleteProperty(downgraded, 'checkedAt');
      Reflect.deleteProperty(downgraded, 'expiresAt');
    }
    let type = 'mcp.server_discovered';
    let data: unknown = downgraded;
    if (kind === 'changed') {
      type = 'mcp.tools_changed';
      data = { serverId: 'fixture', previousSchemaDigest: snapshot.schemaDigest,
        newSchemaDigest: downgraded.schemaDigest, catalogue: downgraded };
    }
    const next = { ...event('new-unversioned', 'mcp-fixture', type),
      time: new Date().toISOString(), data };
    const expectedSequence = await nats.store.head('mcp-fixture');
    const result = await nats.store.append({ event: next, expectedSequence });
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
    expect(await nats.store.head('mcp-fixture')).toBe(expectedSequence);
    expect(await history(nats.store, 'mcp-fixture', 'test')).toEqual(before);
  } finally {
    await nats.close();
  }
}
it.each(['discovery', 'undated', 'changed', 'full-list'] as const)(
  'refuses a new unversioned %s after v2 without saving anything', refusesUnversionedAppend);

async function refusesAcceptedOnlyV2Append(undated: boolean) {
  const snapshot = await captureCatalogue([ordinaryWrite, rejectedSibling]);
  const invalid = { ...snapshot, schemaDigest: catalogueDigest(snapshot.tools!) };
  if (undated) {
    Reflect.deleteProperty(invalid, 'checkedAt');
    Reflect.deleteProperty(invalid, 'expiresAt');
  }
  const nats = await natsFixture();
  try {
    const record = { ...event('invalid-v2', 'mcp-fixture', 'mcp.server_discovered'),
      data: invalid };
    const result = await nats.store.append({ event: record, expectedSequence: 0 });
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
    expect(await nats.store.head('mcp-fixture')).toBe(0);
  } finally {
    await nats.close();
  }
}
it.each([false, true])('refuses an accepted-only digest marked v2, undated: %s',
  refusesAcceptedOnlyV2Append);
