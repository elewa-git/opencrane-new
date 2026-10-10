import { expect, it } from 'vitest';
import { egressDestinationSchema, parseEventByType } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { egressPolicy, readEgressRule, egressRulesAllow, egressGrantStream, ProjectionRunner,
  auditTrail, readAudit } from '../src/index.ts';
import { database } from './database.ts';

const destination = { host: 'registry.npmjs.org', port: 443 };
const siloRule = { silo: 'test', scope: 'silo' as const, subjectId: 'test', ...destination };
const personRule = { ...siloRule, scope: 'person' as const, subjectId: 'alice' };
const assistantRule = { ...siloRule, scope: 'assistant' as const, subjectId: 'helper' };

function exactIntersection() {
  const rules = [siloRule, personRule, assistantRule];
  const allowed = rules.map(allowRule);
  expect(egressRulesAllow(allowed, 'test', 'alice', 'helper', destination)).toBe(true);
  for (let index = 0; index < rules.length; index++) {
    const changed = [...allowed];
    changed[index] = { ...changed[index]!, allowed: false };
    expect(egressRulesAllow(changed, 'test', 'alice', 'helper', destination)).toBe(false);
    changed[index] = { ...allowed[index]!, port: 8443 };
    expect(egressRulesAllow(changed, 'test', 'alice', 'helper', destination)).toBe(false);
  }
  expect(egressRulesAllow(allowed, 'other', 'alice', 'helper', destination)).toBe(false);
  expect(egressRulesAllow(allowed, 'test', 'bob', 'helper', destination)).toBe(false);
  expect(egressRulesAllow(allowed, 'test', 'alice', 'other', destination)).toBe(false);
  expect(egressRulesAllow(allowed, 'test', 'alice', 'helper', {
    host: 'cdn.registry.npmjs.org', port: 443,
  })).toBe(false);
}
function allowRule(rule: typeof siloRule | typeof personRule | typeof assistantRule) {
  return { ...rule, allowed: true };
}
it('requires all three exact rules without owner, suffix or other subject fallback', exactIntersection);

function validatesDestinations() {
  expect(egressDestinationSchema.parse({ host: 'REGISTRY.NPMJS.ORG' })).toEqual(destination);
  expect(egressDestinationSchema.parse({ host: 'bücher.de' }).host).toBe('xn--bcher-kva.de');
  expect(egressDestinationSchema.parse({ host: 'test.com' }).host).toBe('test.com');
  for (const host of ['*.npmjs.org', 'localhost', '127.0.0.1', '2130706433', '0x7f000001',
    '[::1]', '127.0.0.0x1', 'https://npmjs.org', 'a@npmjs.org', 'npmjs.org/path', 'npmjs.org?key=x',
    'npmjs.org#x', 'npmjs.org.', 'a..org', '-a.org', 'a-.org', 'host.internal',
    'metadata.google.internal', 'service.svc.cluster.local', 'a'.repeat(64) + '.org']) {
    expect(egressDestinationSchema.safeParse({ host }).success, host).toBe(false);
  }
  for (const port of [0, 65536, 1.5, '443', NaN]) {
    expect(egressDestinationSchema.safeParse({ ...destination, port }).success).toBe(false);
  }
}
it('normalises DNS names and refuses malformed, numeric and internal destinations', validatesDestinations);

async function replayRestoresRevocation() {
  const db = await database('pg');
  const nats = await natsFixture();
  const runner = new ProjectionRunner(db.db, nats.reader,
    createLogger('egress-test', { level: 'silent' }));
  try {
    await runner.initialise(egressPolicy);
    await runner.initialise(auditTrail);
    const subject = egressGrantStream('test', personRule);
    let expectedSequence = 0;
    for (const type of ['egress.destination_allowed', 'egress.destination_revoked']) {
      const record = { ...event(type, subject, type),
        principal: { kind: 'human' as const, id: 'owner' }, correlation: { request: 'policy-save' },
        data: { scope: 'person', subjectId: 'alice', ...destination, changedBy: 'owner', expectedSequence } };
      const result = await nats.store.append({ event: record, expectedSequence });
      expect(result.status).toBe('appended');
      expectedSequence = await nats.store.head(subject);
    }
    await runner.run(egressPolicy);
    await runner.run(auditTrail);
    const audit = await readAudit(db.db, 'test');
    expect(audit.rows).toHaveLength(2);
    for (const row of audit.rows) {
      expect(row.records[0]?.source).toBe('authoritative');
    }
    const before = await readEgressRule(db.db, 'test', personRule);
    expect(before).toMatchObject({ allowed: false, changedBy: 'owner', sequence: expectedSequence });
    expect(await readEgressRule(db.db, 'other', personRule)).toBeUndefined();
    await runner.rebuild(egressPolicy);
    expect(await readEgressRule(db.db, 'test', personRule)).toEqual(before);
    expect(await nats.store.head(subject)).toBe(expectedSequence);
  } finally {
    await nats.close();
    await db.close();
  }
}
it('rebuilds the revoked rule and original receipt references only from events', replayRestoresRevocation);

function refusesWrongRuleIdentity() {
  const data = { scope: 'person', subjectId: 'alice', ...destination,
    expectedSequence: 0, changedBy: 'owner' };
  const record = { ...event('rule', egressGrantStream('test', personRule),
    'egress.destination_allowed'), principal: { kind: 'human' as const, id: 'owner' }, data };
  expect(parseEventByType(record).success).toBe(true);
  expect(parseEventByType({ ...record, subject: 'egress-wrong' }).success).toBe(false);
  expect(parseEventByType({ ...record, data: { ...data, changedBy: 'other' } }).success).toBe(false);
}
it('refuses saved rules with malformed subjects or a mismatched actor', refusesWrongRuleIdentity);
