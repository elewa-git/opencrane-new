import { expect, it, vi } from 'vitest';
import { currentAuthority, payingGroupAuthority } from '../src/index.ts';
import { fixture } from './fixture.ts';

const refusesStandaloneRevocation = async () => {
  const setup = await fixture();
  const originalRead = setup.nats.store.readStream.bind(setup.nats.store);
  let removed = false;
  async function* removeAfterHistory(...args: Parameters<typeof originalRead>) {
    yield* originalRead(...args);
    if (args[0] === 'member-alice' && !removed) {
      removed = true;
      await setup.append('member-alice', 'member.removed', {
        memberId: 'alice', removedBy: 'owner',
      });
    }
  }
  const race = vi.spyOn(setup.nats.store, 'readStream').mockImplementation(removeAfterHistory);
  try {
    const authority = currentAuthority(setup.nats.store, setup.binding,
      'alice', 'assistant', 'conversation', 'model', 'gpt-6-luna');
    await expect(authority).rejects.toThrow('Authority changed');
  } finally {
    race.mockRestore();
    await setup.close();
  }
};
it('refuses standalone authority revoked after its member history was read', refusesStandaloneRevocation, 40_000);

const refusesStandaloneExpiry = async () => {
  const setup = await fixture();
  const originalRead = setup.nats.store.readStream.bind(setup.nats.store);
  const started = performance.now();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  let expired = false;
  async function* expireAfterHistory(...args: Parameters<typeof originalRead>) {
    yield* originalRead(...args);
    if (args[0] === 'member-alice' && !expired) {
      expired = true;
      clock.mockReturnValue(started + 2001);
    }
  }
  const delay = vi.spyOn(setup.nats.store, 'readStream').mockImplementation(expireAfterHistory);
  try {
    const authority = currentAuthority(setup.nats.store, setup.binding,
      'alice', 'assistant', 'conversation', 'model', 'gpt-6-luna');
    await expect(authority).rejects.toThrow('Authority snapshot expired');
  } finally {
    clock.mockRestore();
    delay.mockRestore();
    await setup.close();
  }
};
it('refuses standalone authority after its original two-second deadline', refusesStandaloneExpiry, 40_000);

const refusesRemovedSiloMember = async () => {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  try {
    await setup.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'admin',
    });
    const authority = payingGroupAuthority(setup.nats.store, 'test',
      'alice', 'sales', setup.binding);
    await expect(authority).rejects.toThrow('Active silo membership required');
  } finally {
    await setup.close();
  }
};
it('refuses group spending after silo removal while IAM still permits membership', refusesRemovedSiloMember, 40_000);
