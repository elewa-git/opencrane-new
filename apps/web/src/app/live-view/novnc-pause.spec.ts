// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser shims need test-only types. */
import { expect, it, vi } from 'vitest';
import RFB from '@novnc/novnc/lib/rfb.js';
import { LeaseChannel } from './lease-channel';

function fakeContext() {
  const context: Record<string, unknown> = {
    createImageData: function createImageData(width: number, height: number) {
      return imageData(width, height);
    },
    getImageData: function getImageData(_x: number, _y: number, width: number, height: number) {
      return imageData(width, height);
    },
  };
  function get(target: Record<string, unknown>, key: string | symbol) {
    if (key in target) return target[key as string];
    return function ignoreCanvasOperation() {};
  }
  function set() { return true; }
  return new Proxy(context, { get, set });
}

function imageData(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  return { width, height, data };
}

class FakeSocket extends EventTarget {
  binaryType = 'blob';
  readyState = 0;
  protocol = 'binary';
  sent: Uint8Array[] = [];

  send(data: ArrayBuffer | ArrayBufferView) {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(Uint8Array.from(bytes));
  }

  close() {}

  binary(bytes: number[] | Uint8Array) {
    const data = Uint8Array.from(bytes).buffer;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  text(value: string) {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
}

function serverInit() {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 800);
  view.setUint16(2, 600);
  bytes[4] = 32;
  bytes[5] = 24;
  bytes[7] = 1;
  view.setUint16(8, 255);
  view.setUint16(10, 255);
  view.setUint16(12, 255);
  bytes[14] = 16;
  bytes[15] = 8;
  return bytes;
}

function framebufferUpdate() {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1);
  view.setUint16(8, 1);
  view.setUint16(10, 1);
  bytes.fill(9, 16);
  return bytes;
}

function installCanvasShims() {
  const canvasPrototype = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  canvasPrototype.getContext = function getContext() {
    return fakeContext() as unknown as CanvasRenderingContext2D;
  };
  vi.stubGlobal('ImageData', class ImageDataShim {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  });
  vi.stubGlobal('ResizeObserver', class ResizeObserverShim {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
}

function recordDisconnect(events: string[]) {
  return function disconnected(event: Event) {
    const detail = (event as CustomEvent<unknown>).detail;
    events.push(`disconnect:${JSON.stringify(detail)}`);
  };
}

function recordConnect(events: string[], name: string) {
  return function connected() { events.push(name); };
}

function messageTypes(messages: Uint8Array[]) {
  return messages.map(function messageType(bytes) {
    return [bytes[0], bytes.length];
  });
}

function realNoVncPauseAndResume() {
  installCanvasShims();
  const socket = new FakeSocket();
  const invalid = vi.fn();
  const notice = vi.fn();
  const events: string[] = [];
  const channel = new LeaseChannel(socket as unknown as WebSocket, { notice, invalid });
  const target = document.createElement('div');
  document.body.append(target);

  const first = new RFB(target, channel.attachViewer());
  first.viewOnly = true;
  first.addEventListener('connect', recordConnect(events, 'connect:first'));
  first.addEventListener('disconnect', recordDisconnect(events));
  socket.readyState = WebSocket.OPEN;
  socket.dispatchEvent(new Event('open'));
  socket.text('{"lease":"valid","at":0,"until":1500}');
  socket.binary(new TextEncoder().encode('RFB 003.008\n'));
  socket.binary([1, 1]);
  socket.binary([0, 0, 0, 0]);
  socket.binary(serverInit());
  expect(events).toEqual(['connect:first']);

  socket.binary(framebufferUpdate());
  expect(target.querySelectorAll('canvas')).toHaveLength(1);
  first.disconnect();
  channel.detachViewer();
  target.replaceChildren();
  expect(events.some(function disconnected(entry) {
    return entry.startsWith('disconnect:');
  })).toBe(true);
  expect(target.querySelectorAll('canvas')).toHaveLength(0);

  socket.binary(framebufferUpdate());
  const sentBeforeResume = socket.sent.length;
  const second = new RFB(target, channel.attachViewer());
  second.viewOnly = true;
  second.addEventListener('connect', recordConnect(events, 'connect:second'));
  second.addEventListener('disconnect', recordConnect(events, 'disconnect:second'));
  channel.replayHandshake();

  const replayMessages = socket.sent.slice(sentBeforeResume);
  expect(invalid).not.toHaveBeenCalled();
  expect(events).toContain('connect:second');
  expect(messageTypes(replayMessages)).toEqual([[0, 20], [2, 92], [3, 10]]);

  socket.binary(framebufferUpdate());
  expect(events).not.toContain('disconnect:second');
  expect(target.querySelectorAll('canvas')).toHaveLength(1);
}

it('real noVNC connects, tears down on pause and resumes with only display setup messages',
  realNoVncPauseAndResume);
