import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { handlerSubscriptions } from '@opencrane/events';
import { envelope, readHostedAdmission } from '@opencrane/models';
import { hostedImageCheckHandler, recoverHostedImageChecks }
  from '../src/hosted-image-check.ts';

const digest = 'a'.repeat(64);
const serverId = 'saved-image';
const silo = 'test';
let fixture: Awaited<ReturnType<typeof natsFixture>>;

async function setup() {
  fixture = await natsFixture();
}

async function cleanup() {
  await fixture.close();
}

beforeEach(setup);
afterEach(cleanup);

async function saveRegistration() {
  const data = { serverId, registeredBy: 'alice', kind: 'hosted',
    locator: `registry.example/team/image@sha256:${digest}`,
    installation: { attemptId: 1, platform: 'linux/amd64',
      upstream: { host: 'service.example', port: 443 } } };
  const event = envelope(silo, `mcp-${serverId}`, 'mcp.server_registered', data);
  event.principal = { kind: 'human', id: 'alice' };
  const result = await fixture.store.append({ event, expectedSequence: 0 });
  expect(result.status).toBe('appended');
  return event;
}

async function callsCheckedWriterOnlyForSavedAttempt() {
  const saved = await saveRegistration();
  const run = vi.fn().mockResolvedValue({ status: 'appended' });
  const handler = hostedImageCheckHandler(fixture.store, silo, run);
  expect(handlerSubscriptions['check-hosted-image']).toEqual([
    'mcp.server_registered', 'mcp.image_check_requested',
  ]);
  await handler.handle(saved, {} as never);
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(fixture.store, silo, serverId, 1,
    expect.any(Function), expect.any(Function), expect.any(Function), expect.anything());
  expect((await readHostedAdmission(fixture.store, silo, serverId))?.status).toBe('checking');

  await handler.handle(saved, {} as never);
  expect(run).toHaveBeenCalledTimes(2);
  const foreign = { ...saved, silo: 'other' };
  await handler.handle(foreign, {} as never);
  expect(run).toHaveBeenCalledTimes(2);
  const changed = { ...saved, data: { ...saved.data, locator: 'changed' } };
  await handler.handle(changed, {} as never);
  expect(run).toHaveBeenCalledTimes(2);
}
it('delivers the saved attempt to the checked writer and refuses changed jobs',
  callsCheckedWriterOnlyForSavedAttempt);

async function recoversQueueLossFromEvents() {
  const saved = await saveRegistration();
  const enqueue = vi.fn();
  const runtime = { options: { silo, handlers: [
    hostedImageCheckHandler(fixture.store, silo, vi.fn()),
  ] }, enqueue };
  const restored = await recoverHostedImageChecks(runtime as never, fixture.reader);
  expect(restored).toBe(1);
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0]?.[1]).toEqual(saved);
  expect((await readHostedAdmission(fixture.store, silo, serverId))?.status).toBe('checking');
}
it('recovers a lost image job from saved history without creating scan evidence',
  recoversQueueLossFromEvents);
