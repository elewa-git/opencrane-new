import { z } from 'zod';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewDelivery } from '../src/computers/view-delivery.ts';
import { ViewLease } from '../src/computers/view-lease.ts';
import { ViewCheckUnavailable } from '../src/computers/view-access.ts';

function fakeTime() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'performance', 'Date'] });
  vi.setSystemTime(0);
}
beforeEach(fakeTime);
function restoreTime() {
  vi.useRealTimers();
}
afterEach(restoreTime);
async function deliveryFixture(expiresAt = 60_000) {
  let available = true;
  let now = 0;
  const clock = { now: function readClock() { return now; } };
  const sent: (Buffer | string)[] = [];
  const written: Buffer[] = [];
  const order: (Buffer | string)[] = [];
  const viewer = { bufferedAmount: 0, send: function send(data: Buffer | string) {
    sent.push(data);
    order.push(data);
  } };
  const desktop = new PassThrough();
  function receive(data: Buffer) {
    written.push(data);
    order.push(data);
  }
  desktop.on('data', receive);
  const stopped = vi.fn();
  function check() {
    if (available) return Promise.resolve('computer');
    return Promise.reject(new ViewCheckUnavailable('authorisation'));
  }
  function resumed() { delivery.leaseResumed(); }
  function renewed() { delivery.leaseRenewed(); }
  function paused() { delivery.leasePaused(); }
  const events = { resumed, renewed, paused, denied: stopped, unconfirmed: stopped };
  const lease = new ViewLease(check, 'computer', events, clock);
  const delivery = new ViewDelivery(lease, expiresAt, stopped, clock);
  lease.start();
  await vi.advanceTimersByTimeAsync(0);
  delivery.attach(viewer, desktop);
  function lapse() {
    available = false;
    // Moving time without running timers exercises the synchronous send boundary.
    now += 2000;
    vi.setSystemTime(now);
  }
  function advanceClock(nextNow: number) {
    now = nextNow;
  }
  async function resume() {
    available = true;
    await vi.advanceTimersByTimeAsync(250);
  }
  return { sent, written, order, stopped, delivery, lease, lapse, resume, advanceClock };
}
async function gate() {
  const fixture = await deliveryFixture();
  fixture.lapse();
  fixture.delivery.toBrowser(Buffer.from('update'), false);
  fixture.delivery.toBrowser(Buffer.from('bell'), false);
  expect(fixture.sent).toEqual([
    JSON.stringify({ lease: 'valid', at: 0, until: 1500 }), '{"lease":"paused"}',
  ]);
  fixture.lease.stop();
}
it(
  'gates desktop bytes at send time and sends only one paused notice',
  gate,
);
async function repeatedPauses() {
  const fixture = await deliveryFixture();
  fixture.lapse();
  fixture.delivery.toBrowser(Buffer.from('first update'), false);
  await fixture.resume();
  fixture.lapse();
  fixture.delivery.toBrowser(Buffer.from('second update'), false);
  const pausedNotices = fixture.sent.filter(function isPausedNotice(message) {
    return typeof message === 'string' && message === '{"lease":"paused"}';
  });
  expect(pausedNotices).toHaveLength(2);
  fixture.lease.stop();
}
it(
  'sends exactly one paused notice for each pause across a resume',
  repeatedPauses,
);
async function release() {
  const fixture = await deliveryFixture();
  fixture.lapse();
  fixture.delivery.toBrowser(Buffer.from('greeting'), true);
  fixture.delivery.toBrowser(Buffer.from('security'), true);
  fixture.delivery.toBrowser(Buffer.from('update'), false);
  fixture.delivery.toDesktop(Buffer.from('request'));
  expect(fixture.written).toEqual([]);
  await fixture.resume();
  expect(fixture.sent.slice(2)).toEqual([
    '{"lease":"valid","at":2000,"until":3500}',
    Buffer.from('greeting'), Buffer.from('security'),
  ]);
  expect(fixture.written).toEqual([Buffer.from('request')]);
  expect(fixture.order.slice(2)).toEqual([
    '{"lease":"valid","at":2000,"until":3500}',
    Buffer.from('greeting'), Buffer.from('security'), Buffer.from('request'),
  ]);
  fixture.lease.stop();
}
it(
  'releases setup then browser bytes after valid and never releases paused updates',
  release,
);
async function bounds() {
  const fixture = await deliveryFixture();
  fixture.lapse();
  fixture.delivery.toDesktop(Buffer.alloc(8192));
  expect(fixture.stopped).not.toHaveBeenCalled();
  fixture.delivery.toDesktop(Buffer.alloc(1));
  expect(fixture.stopped).toHaveBeenCalledWith('slow_viewer');
  fixture.lease.stop();
  const setup = await deliveryFixture();
  setup.lapse();
  setup.delivery.toBrowser(Buffer.alloc(2048), true);
  setup.delivery.toBrowser(Buffer.alloc(1), true);
  expect(setup.stopped).toHaveBeenCalledWith('protocol');
  setup.lease.stop();
}
it(
  'bounds held browser bytes at 8 KiB and setup bytes at 2 KiB',
  bounds,
);
async function expiry() {
  const fixture = await deliveryFixture(1000);
  fixture.sent.length = 0;
  fixture.lapse();
  fixture.delivery.toBrowser(Buffer.from('greeting'), true);
  fixture.delivery.toDesktop(Buffer.from('request'));
  expect(fixture.stopped).toHaveBeenCalledWith('expired');
  expect(fixture.sent).toEqual([]);
  expect(fixture.written).toEqual([]);
  fixture.lease.stop();
}
it(
  'stops expired delivery without sending desktop or browser bytes',
  expiry,
);
async function notices() {
  const fixture = await deliveryFixture();
  fixture.advanceClock(500.25);
  await vi.advanceTimersByTimeAsync(500);
  for (const message of fixture.sent) {
    if (typeof message !== 'string') throw new Error('Expected notice');
    const schema = z.object({ at: z.number(), until: z.number() });
    const notice = schema.parse(JSON.parse(message));
    expect(Number.isInteger(notice.at)).toBe(true);
    expect(Number.isInteger(notice.until)).toBe(true);
    expect(notice.until - notice.at).toBeGreaterThanOrEqual(1);
    expect(notice.until - notice.at).toBeLessThanOrEqual(1500);
  }
  fixture.lapse();
  fixture.delivery.toDesktop(Buffer.from('request'));
  fixture.delivery.stop();
  await fixture.resume();
  expect(fixture.written).toEqual([]);
  fixture.lease.stop();
}
it(
  'uses integer bounded notices on renewals and drops held bytes after stop',
  notices,
);
