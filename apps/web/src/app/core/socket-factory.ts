// Keep only the WebSocket features the client uses. Tests replace this factory
// with a fake socket so they never open a network connection.
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

// The WebSocket standard sets OPEN to 1. Give that value a name so callers
// do not have to remember the number.
export const SOCKET_OPEN = 1;

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>('SOCKET_FACTORY', {
  factory: () => (url: string) => new WebSocket(url),
});

// Add a random delay so clients do not all reconnect at once. Tests replace
// this value with a fixed sequence so they can check the timing.
export const RANDOM_SOURCE = new InjectionToken<() => number>('RANDOM_SOURCE', {
  factory: () => Math.random,
});

// Build the default socket address from the page address. Tests replace it
// to check pages loaded over HTTP and HTTPS.
export type PageLocation = Pick<Location, 'protocol' | 'host'>;

export const PAGE_LOCATION = new InjectionToken<PageLocation>('PAGE_LOCATION', {
  factory: () => window.location,
});
