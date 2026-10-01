// The narrow slice of the browser WebSocket API the client service needs,
// and an injectable factory for creating one. Tests swap this token for a
// fake socket so they never open a real network connection.
import { InjectionToken } from '@angular/core';

export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

// WebSocket.OPEN is always 1 by spec; kept as a named constant so callers
// never have to remember the magic number.
export const SOCKET_OPEN = 1;

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>('SOCKET_FACTORY', {
  factory: () => (url: string) => new WebSocket(url),
});

// The reconnect delay is randomised (full jitter) so many clients do not
// all retry in lockstep. Tests override this token with a fixed sequence
// so the delay maths are predictable.
export const RANDOM_SOURCE = new InjectionToken<() => number>('RANDOM_SOURCE', {
  factory: () => Math.random,
});

// Where the page was loaded from. The default socket address is built from
// it, and tests swap it so they can check both http and https pages.
export type PageLocation = Pick<Location, 'protocol' | 'host'>;

export const PAGE_LOCATION = new InjectionToken<PageLocation>('PAGE_LOCATION', {
  factory: () => window.location,
});
