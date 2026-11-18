import { expect, it, onTestFinished, vi } from 'vitest';
import { manualClock, natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '../src/budget-migration.ts';
import { decisionProvider } from '../src/decision-provider.ts';
import { providerSecretRef } from '../src/providers.ts';
import type { ProviderSecrets } from '../src/provider-secrets.ts';

async function providerFixture() {
  const clock = manualClock(1_000_000);
  const nats = await natsFixture({ clock });
  onTestFinished(nats.close.bind(nats));
  const provider = { providerId: 'primary', changedBy: 'alice' };
  const created = envelope('test', 'provider-primary', 'provider.created', {
    ...provider, revision: 1, provider: 'openai', name: 'Primary',
  });
  const saved = envelope('test', 'provider-primary', 'provider.key_saved', {
    ...provider, revision: 2, secretRef: providerSecretRef('test', 'primary', 'saved'),
  }, 'saved');
  const selected = envelope('test', 'provider-primary', 'provider.models_selected', {
    ...provider, revision: 3, models: ['gpt-6-luna'],
  });
  await nats.seed([created, saved, selected]);
  const head = await nats.store.head();
  const checked = await decisionProvider(nats.store, 'test',
    { providerId: 'primary', model: 'gpt-6-luna' }, clock.now() + 10_000, head);
  return { clock, checked };
}

async function ignoresSave() {}
async function ignoresRemove() {}

async function credentialBoundary(elapsed: number) {
  const { clock, checked } = await providerFixture();
  // Isolate delivery validation from the independent deadline timer.
  const timerClock = manualClock();
  vi.spyOn(clock, 'sleep').mockImplementation(timerClock.sleep.bind(timerClock));
  function read() {
    clock.advance(elapsed);
    return Promise.resolve('fixture-value');
  }
  const secrets = { read, save: ignoresSave, remove: ignoresRemove } satisfies ProviderSecrets;
  const deadline = clock.now() + 2000;
  const reading = checked.credential(secrets, deadline);
  if (elapsed < 2000) {
    await expect(reading).resolves.toBe('fixture-value');
  } else {
    await expect(reading).rejects.toThrow('Provider custody unavailable');
  }
}
it.each([1999, 2000, 2001])('checks credential delivery after %i ms', credentialBoundary);

async function hungCredentialRead() {
  const { clock, checked } = await providerFixture();
  const pending = Promise.withResolvers<string>();
  function read() {
    return pending.promise;
  }
  const secrets = { read, save: ignoresSave, remove: ignoresRemove } satisfies ProviderSecrets;
  const reading = checked.credential(secrets, clock.now() + 2000);
  const refusal = expect(reading).rejects.toThrow('Provider custody unavailable');
  clock.advance(1999);
  await Promise.resolve();
  clock.advance(1);
  await refusal;
  pending.resolve('late-fixture-value');
}
it('expires a hung credential read when the manual clock reaches its deadline', hungCredentialRead);

async function alreadyExpired() {
  const { clock, checked } = await providerFixture();
  const read = vi.fn();
  read.mockResolvedValue('fixture-value');
  const secrets = { read, save: ignoresSave, remove: ignoresRemove } satisfies ProviderSecrets;
  await expect(checked.credential(secrets, clock.now())).rejects.toThrow('Provider custody unavailable');
  expect(read).not.toHaveBeenCalled();
}
it('refuses an already expired credential read before opening custody', alreadyExpired);
