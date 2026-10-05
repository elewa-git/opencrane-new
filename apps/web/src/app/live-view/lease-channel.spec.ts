import { afterEach, expect, it, vi } from 'vitest';
import { LeaseChannel, parseLeaseNotice } from './lease-channel';

class FakeSocket extends EventTarget {
  static readonly CLOSED = WebSocket.CLOSED;
  static last: FakeSocket;
  constructor() {
    super();
    FakeSocket.last = this;
  }
  binaryType = 'blob';
  readyState = 1;
  protocol = 'binary';
  send = vi.fn();
  message(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}
function channelFixture() {
  vi.stubGlobal('WebSocket', FakeSocket);
  const transport = new WebSocket('ws://test');
  const socket = FakeSocket.last;
  const notice = vi.fn();
  const invalid = vi.fn();
  const events = { notice, invalid };
  const channel = new LeaseChannel(transport, events);
  return { socket, notice, invalid, channel };
}
function restoreTime() {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
afterEach(restoreTime);
function parse() {
  expect(parseLeaseNotice('{"lease":"paused"}')).toEqual({ lease: 'paused' });
  expect(parseLeaseNotice('{"lease":"valid","at":0,"until":1500}'))
    .toEqual({ lease: 'valid', at: 0, until: 1500 });
  const invalid = ['1', 'null', '[]', '{',
    '{"lease":"paused","at":0}', '{"lease":"valid","at":0,"until":0}',
    '{"lease":"valid","at":0,"until":1501}',
    '{"lease":"valid","at":0.5,"until":100}',
    '{"lease":"valid","at":-1,"until":100}',
    '{"lease":"valid","at":0,"until":100,"extra":true}'];
  for (const text of invalid) expect(parseLeaseNotice(text)).toBeUndefined();
}
it(
  'accepts only the two exact lease notice shapes',
  parse,
);
function frames() {
  const fixture = channelFixture();
  const port = fixture.channel.attachViewer();
  port.onmessage = vi.fn();
  fixture.socket.message('{"lease":"paused"}');
  expect(port.onmessage).not.toHaveBeenCalled();
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  fixture.socket.message(bytes);
  expect(port.onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: bytes }));
  fixture.socket.message('123');
  expect(fixture.invalid).toHaveBeenCalledOnce();
}
it(
  'consumes text notices and passes binary frames byte for byte',
  frames,
);
function clock() {
  vi.useFakeTimers({ toFake: ['performance'] });
  const fixture = channelFixture();
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  expect(fixture.channel.localDeadline({ lease: 'valid', at: 0, until: 1500 })).toBe(1600);
  now.mockReturnValue(900);
  expect(fixture.channel.localDeadline({ lease: 'valid', at: 250, until: 1750 })).toBe(1850);
}
it(
  'uses the smallest clock offset so queued notices cannot extend permission',
  clock,
);
function replay() {
  const fixture = channelFixture();
  const port = fixture.channel.attachViewer();
  port.onclose = vi.fn();
  port.onmessage = vi.fn();
  const frames = [new Uint8Array([1]).buffer, new Uint8Array([2]).buffer,
    new Uint8Array([3]).buffer, new Uint8Array([4]).buffer];
  for (const frame of frames) fixture.socket.message(frame);
  expect(fixture.channel.handshakeComplete).toBe(true);
  fixture.channel.detachViewer();
  expect(port.onclose).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused' }));
  fixture.socket.message(new Uint8Array([99]).buffer);
  expect(port.onmessage).toHaveBeenCalledTimes(4);
  const resumed = fixture.channel.attachViewer();
  const received: ArrayBuffer[] = [];
  resumed.onmessage = function message(event: MessageEvent<unknown>) {
    if (!(event.data instanceof ArrayBuffer)) throw new Error('Expected binary frame');
    received.push(event.data);
  };
  fixture.channel.replayHandshake();
  expect(received).toEqual(frames);
  const handshake = new TextEncoder().encode('RFB 003.008\n\x01\x01');
  resumed.send(handshake.subarray(0, 5));
  resumed.send(handshake.subarray(5));
  expect(fixture.socket.send).not.toHaveBeenCalled();
  const request = new Uint8Array([3, 0]);
  resumed.send(request);
  expect(fixture.socket.send).toHaveBeenCalledWith(request);
}
it(
  'closes the detached port, drops frames and replays the four recorded handshake frames',
  replay,
);
function mismatch() {
  const fixture = channelFixture();
  fixture.channel.attachViewer();
  for (let index = 0; index < 4; index++) fixture.socket.message(new ArrayBuffer(1));
  fixture.channel.detachViewer();
  const resumed = fixture.channel.attachViewer();
  resumed.send(new Uint8Array([0]));
  expect(fixture.invalid).toHaveBeenCalledOnce();
}
it(
  'rejects a changed replay handshake',
  mismatch,
);
