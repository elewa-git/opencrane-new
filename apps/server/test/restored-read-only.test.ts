import { expect, it, vi } from 'vitest';
import { testAuthConfig } from '@opencrane/auth/testing';
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
  } finally {
    await app.close();
  }
}
it('holds writes and owner claims while allowing restored reads', keepsRestoredEffectsHeld);
