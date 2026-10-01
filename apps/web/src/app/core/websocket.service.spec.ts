import { TestBed } from '@angular/core/testing';
import {
  PAGE_LOCATION,
  RANDOM_SOURCE,
  SOCKET_FACTORY,
  SOCKET_OPEN,
  type PageLocation,
  type SocketLike,
} from './socket-factory';
import { WebSocketService } from './websocket.service';

// A fake socket the tests drive by hand: no real connection is opened, and
// every open, message and close is triggered explicitly.
class FakeSocket implements SocketLike {
  readyState = 0; // CONNECTING
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent('close'));
  }

  // Test-only helpers; not part of the SocketLike contract.
  triggerOpen(): void {
    this.readyState = SOCKET_OPEN;
    this.onopen?.(new Event('open'));
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

// A real socket delivers `close` on a later turn, not inside `close()`.
// FakeSocket fires it at once, which hides bugs that need the delay; this
// one holds the event back until `deliverPendingClose()`.
class AsyncCloseFakeSocket extends FakeSocket {
  private pendingClose: (() => void) | undefined;

  override close(): void {
    this.readyState = 2; // CLOSING
    this.pendingClose = () => {
      this.readyState = 3; // CLOSED
      this.onclose?.(new CloseEvent('close'));
    };
  }

  deliverPendingClose(): void {
    const close = this.pendingClose;
    this.pendingClose = undefined;
    close?.();
  }
}

describe('WebSocketService', () => {
  let sockets: FakeSocket[];

  function setup(
    random: () => number = () => 0.5,
    socketCtor: new (url: string) => FakeSocket = FakeSocket,
    pageLocation: PageLocation = { protocol: 'http:', host: 'example.test:4200' },
  ): WebSocketService {
    sockets = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SOCKET_FACTORY,
          useValue: (url: string): SocketLike => {
            const socket = new socketCtor(url);
            sockets.push(socket);
            return socket;
          },
        },
        { provide: RANDOM_SOURCE, useValue: random },
        { provide: PAGE_LOCATION, useValue: pageLocation },
      ],
    });
    return TestBed.inject(WebSocketService);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle, then moves to connecting and open', () => {
    const service = setup();
    expect(service.state()).toBe('idle');

    service.connect('/ws');
    expect(service.state()).toBe('connecting');
    expect(sockets).toHaveLength(1);
    expect(service.isConnected()).toBe(false);

    sockets[0]?.triggerOpen();
    expect(service.state()).toBe('open');
    expect(service.isConnected()).toBe(true);
  });

  it.each([
    ['hello echo', { type: 'hello', text: 'hi', echoedAt: '2026-09-30T10:00:00.000Z' }],
    ['error', { type: 'error', message: 'nope' }],
    ['event validation result', { type: 'eventValidationResult', valid: false, reason: 'unknown type' }],
  ])('parses the %s message into lastMessage and the message history', (_name, message) => {
    const service = setup();
    service.connect('/ws');
    sockets[0]?.triggerOpen();

    sockets[0]?.triggerMessage(JSON.stringify(message));

    expect(service.lastMessage()).toEqual(message);
    expect(service.messages()).toEqual([message]);
  });

  it.each([
    ['http:', 'example.test:4200', 'ws://example.test:4200/ws'],
    ['https:', 'example.test', 'wss://example.test/ws'],
  ])('connects to /ws on the page host when given no address (%s page)', (protocol, host, expected) => {
    const service = setup(undefined, undefined, { protocol, host });

    service.connect();

    expect(sockets[0]?.url).toBe(expected);
  });

  it('ignores a message that matches none of the known schemas, without throwing', () => {
    const service = setup();
    service.connect('/ws');
    sockets[0]?.triggerOpen();

    expect(() => sockets[0]?.triggerMessage(JSON.stringify({ type: 'not-a-real-type' }))).not.toThrow();
    expect(service.lastMessage()).toBeUndefined();
  });

  it('ignores a message that is not valid JSON, without throwing', () => {
    const service = setup();
    service.connect('/ws');
    sockets[0]?.triggerOpen();

    expect(() => sockets[0]?.triggerMessage('{not json')).not.toThrow();
    expect(service.lastMessage()).toBeUndefined();
  });

  it('does not reconnect after an explicit disconnect', () => {
    vi.useFakeTimers();
    const service = setup();
    service.connect('/ws');
    sockets[0]?.triggerOpen();

    service.disconnect();
    expect(service.state()).toBe('closed');

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('resets the backoff once a reconnect succeeds', () => {
    vi.useFakeTimers();
    const service = setup(() => 1);
    service.connect('/ws');
    sockets[0]?.triggerOpen();
    sockets[0]?.triggerClose();

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1]?.triggerOpen();
    expect(service.state()).toBe('open');

    sockets[1]?.triggerClose();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // back to the first attempt's delay, not a doubled one
  });

  it('jitters the delay within the cap, instead of always waiting the full cap', () => {
    vi.useFakeTimers();
    // random() = 0.25 on a 500ms cap waits 125ms; using the cap would wait 500ms.
    const service = setup(() => 0.25);
    service.connect('/ws');
    sockets[0]?.triggerOpen();
    sockets[0]?.triggerClose();

    vi.advanceTimersByTime(124);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it('stops the wait from growing past a 30 second ceiling', () => {
    vi.useFakeTimers();
    const service = setup(() => 1);
    service.connect('/ws');
    sockets[0]?.triggerOpen();

    // The wait doubles each time, then holds at 30s (twice, to show a ceiling).
    const expectedCapsMs = [500, 1000, 2000, 4000, 8000, 16000, 30_000, 30_000];
    for (const [attempt, capMs] of expectedCapsMs.entries()) {
      sockets[attempt]?.triggerClose();
      expect(service.state()).toBe('reconnecting');
      vi.advanceTimersByTime(capMs - 1);
      expect(sockets).toHaveLength(attempt + 1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(attempt + 2);
    }
  });

  it('send() only delivers a message while the socket is open', () => {
    const service = setup();
    service.connect('/ws');

    expect(service.send({ type: 'hello', text: 'hi' })).toBe(false);

    sockets[0]?.triggerOpen();
    expect(service.send({ type: 'hello', text: 'hi' })).toBe(true);
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: 'hello', text: 'hi' })]);
  });

  // The three duplicate-socket cases a real browser hit: connect() again
  // while open, while a reconnect is pending, and right after disconnect().
  describe('connect() while a socket already exists', () => {
    it('closes the open socket and leaves exactly the new one in charge', () => {
      const service = setup();
      service.connect('/ws');
      sockets[0]?.triggerOpen();

      service.connect('/ws');

      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.readyState).toBe(3); // the old socket was actually closed
      expect(service.state()).toBe('connecting');

      sockets[1]?.triggerOpen();
      expect(service.send({ type: 'hello', text: 'hi' })).toBe(true);
      expect(sockets[0]?.sent).toEqual([]); // nothing was ever sent on the stale socket
    });

    it('cancels a pending reconnect instead of leaving it to open a third socket', () => {
      vi.useFakeTimers();
      const service = setup(() => 1);
      service.connect('/ws');
      sockets[0]?.triggerOpen();
      sockets[0]?.triggerClose();
      expect(service.state()).toBe('reconnecting');

      service.connect('/ws');

      // The scheduled reconnect must not fire a third socket later.
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
      expect(service.state()).toBe('connecting');
    });

    it('ignores a disconnected socket whose close event arrives late, after connect() already moved on', () => {
      vi.useFakeTimers();
      const service = setup(() => 0.5, AsyncCloseFakeSocket);
      service.connect('/ws');
      const first = sockets[0] as AsyncCloseFakeSocket;
      first.triggerOpen();

      service.disconnect();
      expect(service.state()).toBe('closed');

      service.connect('/ws');
      const second = sockets[1] as AsyncCloseFakeSocket;
      second.triggerOpen();
      expect(service.state()).toBe('open');

      // The first socket's close event finally arrives.
      first.deliverPendingClose();

      expect(service.state()).toBe('open'); // unchanged by the stale event
      expect(sockets).toHaveLength(2); // no reconnect was scheduled off it
      expect(service.send({ type: 'hello', text: 'hi' })).toBe(true);
      expect(second.sent).toEqual([JSON.stringify({ type: 'hello', text: 'hi' })]);
    });
  });
});
