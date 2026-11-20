import { expect, it, vi } from 'vitest';
import { testAuthConfig } from '@opencrane/auth/testing';
import { approvalFixture } from './support/approval-fixture.ts';
import { buildServer } from '../src/server.ts';

async function keepsRestoredEffectsHeld() {
  const app = buildServer(testAuthConfig(), { readOnly: true });
  const effect = vi.fn(function change() { return { status: 'saved' }; });
  function read() { return { status: 'readable' }; }
  app.get('/api/restore-probe', read);
  app.post('/api/restore-probe', effect);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/restore-probe' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', reason: 'restore_read_only' });
    expect(effect).not.toHaveBeenCalled();
    const history = await app.inject({ url: '/api/restore-probe' });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({ status: 'readable' });
    const claim = await app.inject({ method: 'POST', url: '/api/silo/claim' });
    expect(claim.statusCode).toBe(503);
    const joining = await app.inject({ method: 'POST', url: '/members/join' });
    expect(joining.statusCode).toBe(503);
    const signOut = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(signOut.statusCode).not.toBe(503);
  } finally {
    await app.close();
  }
}
it('holds writes and owner claims while allowing restored reads', keepsRestoredEffectsHeld);


async function readsExpiredReviewsWithoutWriting() {
  const setup = await approvalFixture(false, undefined, true);
  try {
    expect((await setup.call()).text).toContain('approvalId');
    const before = await setup.read();
    const position = await setup.nats.store.head();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(before.cards[0]!.expiresAt) + 1);
    const restored = await setup.read();
    expect(await setup.nats.store.head()).toBe(position);
    expect(restored.cards[0]?.state).toBe('cancelled');
    expect(restored.cards[0]?.canApprove).toBe(false);
  } finally {
    vi.useRealTimers();
    await setup.close();
  }
}
it('reads an expired restored approval without recording a new event',
  readsExpiredReviewsWithoutWriting);
