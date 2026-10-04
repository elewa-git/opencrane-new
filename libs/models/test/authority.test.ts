import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { fixture } from './fixture.ts';

it('admits a model decision using only its exact authority streams', async () => {
  const f = await fixture();
  const read = vi.spyOn(f.nats.store, 'readStream');
  const head = vi.spyOn(f.nats.store, 'head');
  try {
    const response = await fetch(`${f.options.decisionUrl}/authorize`, { method: 'POST', headers: f.headers,
      body: JSON.stringify({ model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true }) });
    expect(response.status).toBe(200);
    const relevant = new Set(['member-alice', 'assistant-assistant', 'computer-assistant',
      'conversation-conversation', grantStream('model', 'gpt-6-luna'), 'budget-test',
      `decision-${response.headers.get('x-request-id')}`]);
    expect(read.mock.calls.length).toBeGreaterThan(0);
    expect(read.mock.calls.map(([subject]) => subject).filter(subject => !relevant.has(subject))).toEqual([]);
    expect(head.mock.calls.flatMap(([subject]) => subject === undefined || relevant.has(subject) ? [] : [subject])).toEqual([]);
    expect(f.actor.state.reservations).toHaveLength(1);
  } finally { read.mockRestore(); head.mockRestore(); await f.close(); }
}, 40_000);

it('ignores unrelated IAM changes while fencing a running decision', async () => {
  const f = await fixture();
  const read = f.nats.store.readStream.bind(f.nats.store);
  let changed = false;
  const race = vi.spyOn(f.nats.store, 'readStream').mockImplementation(async function* (...args) {
    yield* read(...args);
    if (args[0] === 'member-alice' && !changed) {
      changed = true;
      await f.append('team-unrelated', 'team.created', { teamId: 'unrelated', name: 'Other team', createdBy: 'other' });
    }
  });
  try {
    expect((await f.call()).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { race.mockRestore(); await f.close(); }
}, 40_000);

it('fences team grants discovered after the snapshot and refuses missing projection receipts', async () => {
  const f = await fixture();
  try {
    await f.append('team-buyers', 'team.created', { teamId: 'buyers', name: 'Buyers', createdBy: 'alice' });
    await f.append('team-buyers', 'team.member_added', { teamId: 'buyers', memberId: 'alice', addedBy: 'alice' });
    const revoked = await f.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
      resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice' });
    await f.auth.handler.handle(revoked, f.db);
    const granted = await f.append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'buyers', granteeKind: 'team', grantedBy: 'alice' });
    await f.auth.handler.handle(granted, f.db);
    expect((await f.call()).status).toBe(200); await f.settled();
    const read = f.nats.store.readStream.bind(f.nats.store);
    let changed = false;
    const race = vi.spyOn(f.nats.store, 'readStream').mockImplementation(async function* (...args) {
      yield* read(...args);
      if (args[0] === grantStream('model', 'gpt-6-luna') && !changed) {
        changed = true;
        await f.append('team-buyers', 'team.member_removed', { teamId: 'buyers', memberId: 'alice', removedBy: 'alice' });
      }
    });
    try { expect((await f.call()).status).toBe(403); }
    finally { race.mockRestore(); }
    expect((await f.call()).status).toBe(403); // OpenFGA still has the old membership.
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);
