import { dirname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { TimeoutError } from '@nats-io/transport-node';
import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../src/index.ts';
import { event, natsFixture } from './testing.ts';

type Fixture = Awaited<ReturnType<typeof natsFixture>>;
const fixtures: Fixture[] = [];

async function closeFixtures() {
  vi.restoreAllMocks();
  for (const fixture of fixtures) {
    await fixture.close();
  }
  fixtures.length = 0;
}

async function startFixture() {
  const fixture = await natsFixture();
  fixtures.push(fixture);
  return fixture;
}

async function reuseCredentials() {
  const [first, second] = await Promise.all([startFixture(), startFixture()]);
  const firstEnv = first.env();
  const secondEnv = second.env();
  expect(dirname(firstEnv.NATS_CERT_FILE)).not.toBe(dirname(secondEnv.NATS_CERT_FILE));
  for (const field of ['NATS_CA_FILE', 'NATS_CERT_FILE', 'NATS_KEY_FILE',
    'NATS_NKEY_SEED_FILE'] as const) {
    const original = await readFile(firstEnv[field]);
    const copied = await readFile(secondEnv[field]);
    // Compare without printing credentials if this assertion fails.
    expect(original.equals(copied)).toBe(true);
    await writeFile(firstEnv[field], 'changed in the first fixture');
    const unchanged = await readFile(secondEnv[field]);
    expect(unchanged.equals(copied)).toBe(true);
  }
  const command = { event: event('isolated'), expectedSequence: 0 };
  expect(await first.store.append(command)).toMatchObject({ status: 'appended' });
  expect(await second.store.head()).toBe(0);
  await first.close();
  fixtures.splice(fixtures.indexOf(first), 1);
  const third = await startFixture();
  const secondSeed = await readFile(secondEnv.NATS_NKEY_SEED_FILE);
  const thirdSeed = await readFile(third.env().NATS_NKEY_SEED_FILE);
  expect(secondSeed.equals(thirdSeed)).toBe(true);
  expect(await third.store.head()).toBe(0);
  expect(await second.store.append(command)).toMatchObject({ status: 'appended' });
}

async function separateAuthority() {
  const shared = await startFixture();
  const fresh = await natsFixture({ freshCertificates: true });
  fixtures.push(fresh);
  const sharedCa = await readFile(shared.env().NATS_CA_FILE);
  const freshCa = await readFile(fresh.env().NATS_CA_FILE);
  expect(sharedCa.equals(freshCa)).toBe(false);
}

async function reportCreationTimeout() {
  const ensure = vi.spyOn(EventStore.prototype, 'ensureStream');
  const failure = new TimeoutError();
  ensure.mockRejectedValueOnce(failure);
  expect(await fixtureSetupError()).toBe(failure);
  expect(ensure).toHaveBeenCalledTimes(1);
}

async function refuseOtherFailures() {
  const ensure = vi.spyOn(EventStore.prototype, 'ensureStream');
  const failure = new Error('Invalid stream configuration');
  ensure.mockRejectedValueOnce(failure);
  expect(await fixtureSetupError()).toBe(failure);
  expect(ensure).toHaveBeenCalledTimes(1);
}

async function fixtureSetupError(): Promise<unknown> {
  let unexpectedFixture: Fixture;
  try {
    unexpectedFixture = await natsFixture();
  } catch (error) {
    return error;
  }
  // Close unexpected successes and keep their credentials out of assertion output.
  await unexpectedFixture.close();
  return undefined;
}

afterEach(closeFixtures);
it('reuses credentials but gives concurrent fixtures separate files and event histories',
  reuseCredentials);
it('can create a separate certificate authority for trust refusal tests', separateAuthority);
it('reports a stream creation timeout without retrying', reportCreationTimeout);
it('does not retry other stream creation failures', refuseOtherFailures);
