import { afterAll, beforeAll, expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { groups, members, modelAccess, ProjectionRunner, readToolGrantReferences }
  from '../src/index.ts';
import { database } from './database.ts';

const subject = grantStream('mcp_server', 'reference-test');
const logger = createLogger('tool-grant-references-test', { level: 'silent' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let counter = 0;

async function appendGrant(silo: string, granteeId: string) {
  const fields = { resourceType: 'mcp_server', resourceId: 'reference-test',
    granteeKind: 'member', granteeId, grantedBy: 'owner' };
  const record = { ...event(`reference-${++counter}`, subject, 'grant.given'),
    silo, data: fields };
  const expectedSequence = await nats.store.head(subject);
  const result = await nats.store.append({ event: record, expectedSequence });
  expect(result.status).toBe('appended');
}

async function initialise() {
  nats = await natsFixture();
  storage = await database('pg');
  const runner = new ProjectionRunner(storage.db, nats.reader, logger);
  for (const projection of [members, groups, modelAccess]) {
    await runner.initialise(projection);
  }
  for (let index = 0; index < 102; index++) {
    const granteeId = `member-${String(index).padStart(3, '0')}`;
    await appendGrant('acme', granteeId);
  }
  await appendGrant('foreign', '000-foreign-canary');
  for (const projection of [members, groups, modelAccess]) {
    await runner.run(projection);
  }
}

async function close() {
  await storage?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

async function boundsReferencesInDatabase() {
  const rows = await readToolGrantReferences(storage.db, 'acme', subject);
  expect(rows).toHaveLength(101);
  expect(rows[0]).toMatchObject({ granteeId: 'member-000' });
  expect(rows.at(-1)).toMatchObject({ granteeId: 'member-100' });
}
it('returns only 101 ordered references from the database', boundsReferencesInDatabase);

async function isolatesReferencesBySilo() {
  const foreign = await readToolGrantReferences(storage.db, 'foreign', subject);
  expect(foreign).toHaveLength(1);
  expect(foreign[0]).toMatchObject({ granteeId: '000-foreign-canary' });
  const local = await readToolGrantReferences(storage.db, 'acme', subject);
  for (const reference of local) {
    expect(reference.granteeId).not.toBe('000-foreign-canary');
  }
}
it('reads references only from the requested silo on a shared subject', isolatesReferencesBySilo);
