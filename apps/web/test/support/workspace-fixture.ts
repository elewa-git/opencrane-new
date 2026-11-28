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
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementation(fetchWorkspace);
  const state = {};
  history.replaceState(state, '', '/workspace?conversation=chat');
  const provider = { provide: SOCKET_FACTORY, useValue: createSocket };
  const configuration = { providers: [provider] };
  TestBed.configureTestingModule(configuration);
  const fixture = TestBed.createComponent(Workspace);
  await fixture.whenStable();
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('Missing workspace');
  }
  return { fixture, root };
}
