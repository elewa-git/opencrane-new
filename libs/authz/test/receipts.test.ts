import { expect, it } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation } from '../src/index.ts';
import { openfga } from './services.ts';

function rejectSql(): never {
  throw new Error('Unexpected SQL');
}

async function receiptAvailability() {
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding);
    const joined = event('receipt-joined', 'member-alice', 'member.joined');
    const noSql = { query: rejectSql };
    await auth.handler.handle(joined, noSql);
    expect(await auth.applied(joined.id)).toBe(true);
    expect(await auth.applied('missing-receipt')).toBe(false);

    await fga.pause();
    await expect(auth.applied(joined.id)).resolves.toBe(false);
    const unavailable = await auth.checkApplied(joined.id);
    expect(unavailable).toMatchObject({ allowed: false, status: 'unavailable' });
    if (unavailable.status !== 'unavailable') {
      throw new Error('Expected an unavailable receipt check');
    }
    expect(unavailable.error.cause).toBeDefined();
    await fga.resume();
    expect(await auth.applied(joined.id)).toBe(true);
    expect(await auth.checkApplied(joined.id)).toEqual({ allowed: true, status: 'ok' });
    expect(await auth.checkApplied('missing-receipt')).toEqual({ allowed: false, status: 'ok' });
  } finally {
    await fga.close();
  }
}

it('keeps boolean receipt checks compatible while exposing outage status', receiptAvailability);
