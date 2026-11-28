import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SOCKET_FACTORY, type SocketLike } from '../../src/app/core/socket-factory';
import { Workspace } from '../../src/app/chat/workspace';

function createSocket(): SocketLike {
  return {
    readyState: 1,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

export async function mountWorkspaceFixture(fetchWorkspace: typeof fetch) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchWorkspace);
  history.replaceState({}, '', '/workspace?conversation=chat');
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  TestBed.configureTestingModule({ providers: [provider] });
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing workspace');
  }
  return { fixture, root };
}
