import { expect, it } from 'vitest';
import { createStore } from '../src/index.ts';
import { objectId, TupleClient } from '../src/client.ts';
import { openfga } from './services.ts';

async function modelRequiresMembershipAndOwnership() {
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const client = new TupleClient(binding);
    const silo = objectId('silo', 'test');
    const target = objectId('routine', 'test', 'orders');
    const alice = objectId('person', 'test', 'alice');
    const bob = objectId('person', 'test', 'bob');
    const aliceMember = { user: alice, object: silo, relation: 'member' };
    const bobMember = { user: bob, object: silo, relation: 'member' };
    const writes = [
      aliceMember, bobMember,
      { user: bob, object: silo, relation: 'admin_role' },
      { user: alice, object: target, relation: 'owner' },
      { user: silo, object: target, relation: 'silo' },
      { user: silo, object: target, relation: 'active_silo' },
    ];
    await client.write(writes, []);
    const aliceManage = { user: alice, object: target, relation: 'manage' };
    const aliceRead = { ...aliceManage, relation: 'read_metadata' };
    const bobManage = { ...aliceManage, user: bob };
    const bobRead = { ...aliceRead, user: bob };
    expect(await client.check(aliceManage)).toEqual({ allowed: true, status: 'ok' });
    expect(await client.check(aliceRead)).toEqual({ allowed: true, status: 'ok' });
    expect(await client.check(bobRead)).toEqual({ allowed: true, status: 'ok' });
    expect(await client.check(bobManage)).toEqual({ allowed: false, status: 'ok' });
    // Leave owner and admin tuples in place to test the model's membership requirements.
    await client.write([], [aliceMember, bobMember]);
    expect(await client.check(aliceRead)).toEqual({ allowed: false, status: 'ok' });
    expect(await client.check(aliceManage)).toEqual({ allowed: false, status: 'ok' });
    expect(await client.check(bobRead)).toEqual({ allowed: false, status: 'ok' });
  } finally {
    await fga.close();
  }
}
it('requires membership and ownership in OpenFGA without TypeScript access checks',
  modelRequiresMembershipAndOwnership, 30_000);
