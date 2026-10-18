import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { BudgetActor, envelope, history } from '../src/actor.ts';
import { applyBudget, budgetSummary, emptyBudget } from '../src/state.ts';
import { configureBudget } from '../src/budget-config.ts';

let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let binding: Awaited<ReturnType<typeof createStore>>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let identity: { jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] }; issuer: string };

async function startServices() {
  fga = await openfga();
  dbs = await databases();
  signing = await generateKeyPair('ES256');
  const publicKey = await exportJWK(signing.publicKey);
  identity = { jwks: { keys: [publicKey] }, issuer: 'https://budget.test' };
}
async function stopServices() {
  await dbs.close();
  await fga.close();
}
async function initialise() {
  nats = await natsFixture();
  binding = await createStore(fga.apiUrl, 'test');
  const member = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'admin',
  });
  await nats.seed([member]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(member, pgDb(dbs.queue));
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 1000, 'original');
}
async function close() {
  await nats.close();
}
beforeAll(startServices, 120_000);
afterAll(stopServices);
beforeEach(initialise);
afterEach(close);

async function save(raw: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(raw));
  const claims = { typ: 'budget-admin', silo: 'test', memberId: 'alice',
    commandDigest: hash.digest('hex') };
  const signed = new SignJWT(claims);
  signed.setProtectedHeader({ alg: 'ES256' });
  signed.setIssuer(identity.issuer);
  signed.setAudience('budget-admin');
  signed.setJti('budget-test');
  signed.setIssuedAt();
  signed.setExpirationTime('2m');
  const token = await signed.sign(signing.privateKey);
  return configureBudget(actor, binding, identity, raw, `Bearer ${token}`);
}

async function refusesUnknownGroup() {
  const before = await nats.store.head('budget-test');
  const command = { commandId: 'unknown', expectedSequence: before,
    scope: 'paying_group', scopeId: 'missing', ceilingCents: 10 };
  await expect(save(command)).rejects.toThrow('Spending choice unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
}
it('refuses an unknown group without saving a ceiling', refusesUnknownGroup);

async function seedGroup(groupId: string, silo = 'test') {
  const group = { teamId: groupId, name: 'Sales', createdBy: 'alice' };
  const event = envelope(silo, `team-${groupId}`, 'team.created', group);
  await nats.seed([event]);
}
async function seedAssistant(kind: 'team' | 'personal' = 'team') {
  await seedGroup('sales');
  const assistant = { assistantId: 'shared', ownerId: 'sales', kind, payingGroupId: 'sales' };
  const event = envelope('test', 'assistant-shared', 'assistant.created', assistant);
  await nats.seed([event]);
}
async function deactivate() {
  const settings = { assistantId: 'shared', changedBy: 'alice', active: false,
    changedFields: ['active'] };
  const event = envelope('test', 'assistant-shared', 'assistant.settings_changed', settings);
  await nats.seed([event]);
}
async function retire() {
  const computer = { assistantId: 'shared', computerId: 'computer' };
  const event = envelope('test', 'computer-shared', 'computer.retired', computer);
  await nats.seed([event]);
}
const invalidChoices = ['foreign', 'personal', 'inactive', 'retired', 'unknown-assistant',
  'unknown-default'] as const;
async function refusesInvalidChoice(problem: typeof invalidChoices[number]) {
  if (problem === 'foreign') await seedGroup('shared', 'other');
  if (problem === 'personal') await seedAssistant('personal');
  if (problem === 'inactive' || problem === 'retired') await seedAssistant();
  if (problem === 'inactive') await deactivate();
  if (problem === 'retired') await retire();
  const before = await nats.store.head('budget-test');
  let choice: Record<string, string> = { scope: 'assistant', scopeId: 'shared' };
  if (problem === 'foreign') choice = { scope: 'paying_group', scopeId: 'shared' };
  if (problem === 'unknown-default') {
    choice = { scope: 'global', defaultPayingGroupId: 'missing' };
  }
  const command = { ...choice, commandId: 'invalid', expectedSequence: before, ceilingCents: 10 };
  await expect(save(command)).rejects.toThrow('Spending choice unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.defaultPayingGroupId).toBe('original');
  expect(actor.state.ceilings).toEqual([]);
}
it.each(invalidChoices)('refuses %s without changing the budget', refusesInvalidChoice);

async function keepsExactChoicesAndReplay() {
  await seedAssistant();
  await seedGroup('chosen');
  const before = await nats.store.head('budget-test');
  const invalidDefault = { commandId: 'invalid-default', expectedSequence: before,
    scope: 'global', defaultPayingGroupId: 'missing', ceilingCents: 1000 };
  await expect(save(invalidDefault)).rejects.toThrow('Spending choice unavailable');
  expect(actor.state.defaultPayingGroupId).toBe('original');
  expect(await nats.store.head('budget-test')).toBe(before);
  const global = { commandId: 'default', expectedSequence: before,
    scope: 'global', defaultPayingGroupId: 'chosen', ceilingCents: 1000 };
  expect(await save(global)).toMatchObject({ status: 'appended' });
  expect(actor.state.defaultPayingGroupId).toBe('chosen');
  const command = { commandId: 'assistant-cap', expectedSequence: actor.state.sequence,
    scope: 'assistant', scopeId: 'shared', ceilingCents: 0 };
  const saved = await save(command);
  expect(saved).toMatchObject({ status: 'appended', budget: { ceilings: [
    { scope: 'assistant', scopeId: 'shared', ceilingCents: 0 },
  ] } });
  await deactivate();
  const position = await nats.store.head();
  expect(await save(command)).toEqual(saved);
  const changedScope = { ...command, scope: 'paying_group' };
  const changedId = { ...command, scopeId: 'sales' };
  const changedDefault = { ...global, defaultPayingGroupId: 'missing' };
  for (const changed of [changedScope, changedId, changedDefault]) {
    expect(await save(changed)).toMatchObject({ status: 'conflict' });
  }
  const replayed = emptyBudget();
  const rows = await history(nats.store, 'budget-test', 'test');
  for (const row of rows) applyBudget(replayed, row.event, row.sequence);
  expect(budgetSummary(replayed, actor.now())).toEqual(saved.budget);
  expect(await nats.store.head()).toBe(position);
}
it('keeps exact choices and saved retries after deactivation, with identical replay',
  keepsExactChoicesAndReplay);

async function demote() {
  const role = { memberId: 'alice', previousRole: 'admin', newRole: 'member',
    changedBy: 'owner' };
  const event = envelope('test', 'member-alice', 'member.role_changed', role);
  await nats.seed([event]);
}
const races = ['deactivate', 'retire', 'demote'] as const;
async function refusesChangeAfterLoading(change: typeof races[number], duringCheck = false) {
  await seedAssistant();
  const before = await nats.store.head('budget-test');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalHead = nats.store.head.bind(nats.store);
  let held = false;
  async function head(subject?: string, deadline?: number) {
    let position: number | undefined;
    if (duringCheck) position = await originalHead(subject, deadline);
    const target = duringCheck ? 'ownership-test' : undefined;
    if (subject === target && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return position ?? await originalHead(subject, deadline);
  }
  const spy = vi.spyOn(nats.store, 'head').mockImplementation(head);
  const command = { commandId: 'racing', expectedSequence: before,
    scope: 'assistant', scopeId: 'shared', ceilingCents: 10 };
  const saving = save(command);
  const refused = expect(saving).rejects.toThrow();
  try {
    await entered.promise;
    if (change === 'deactivate') await deactivate();
    if (change === 'retire') await retire();
    if (change === 'demote') await demote();
  } finally {
    release.resolve();
  }
  await refused;
  spy.mockRestore();
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.ceilings).toEqual([]);
}
async function refusesChangeBeforeCheck(change: typeof races[number]) {
  await refusesChangeAfterLoading(change);
}
it.each(races)('refuses %s saved after history loads', refusesChangeBeforeCheck);

async function refusesChangeDuringCheck(change: typeof races[number]) {
  await refusesChangeAfterLoading(change, true);
}
it.each(races)('refuses %s during the final access check', refusesChangeDuringCheck);

const accessProblems = ['member', 'removed', 'foreign', 'admin-denied', 'iam-unavailable'] as const;
async function refusesCaller(problem: typeof accessProblems[number]) {
  await seedGroup('sales');
  const before = await nats.store.head('budget-test');
  if (problem === 'member') await demote();
  if (problem === 'removed') {
    const removed = { memberId: 'alice', removedBy: 'owner' };
    const event = envelope('test', 'member-alice', 'member.removed', removed);
    await nats.seed([event]);
  }
  if (problem === 'foreign') binding = { ...binding, silo: 'other' };
  if (problem === 'admin-denied') {
    const role = { memberId: 'alice', previousRole: 'admin', newRole: 'member',
      changedBy: 'owner' };
    const event = envelope('test', 'member-alice', 'member.role_changed', role);
    const auth = memberAuthorisation(binding);
    // Keep event-backed membership as Admin while OpenFGA permits membership alone.
    await auth.handler.handle(event, pgDb(dbs.queue));
    expect(await auth.check('alice', 'member')).toMatchObject({ allowed: true });
    expect(await auth.check('alice', 'admin')).toMatchObject({ allowed: false });
  }
  if (problem === 'iam-unavailable') binding = { ...binding, apiUrl: 'http://127.0.0.1:1' };
  const command = { commandId: 'access', expectedSequence: before,
    scope: 'paying_group', scopeId: 'sales', ceilingCents: 10 };
  await expect(save(command)).rejects.toThrow();
  expect(await nats.store.head('budget-test')).toBe(before);
}
it.each(accessProblems)('refuses a budget save when caller access is %s', refusesCaller);
