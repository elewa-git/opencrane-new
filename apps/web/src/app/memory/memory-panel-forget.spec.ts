import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from './memory-panel';

const privateText = 'A private fact that must disappear.';
const savedFact = { memoryId: 'fact-one', revision: 3, text: privateText,
  kind: 'fact', pinned: false, expiresAt: null, savedAt: '2026-10-02T10:00:00Z' };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function scope(scopeKind: 'person' | 'group' | 'assistant_notes') {
  return { scopeId: 'scope', scopeKind, ownerId: 'member', canRead: true,
    audience: { kind: scopeKind, ownerId: 'member' } };
}

function receipt(cleanupStatus: string) {
  return { operation: 'forget', outcome: 'accepted', hidden: true, cleanupStatus,
    memoryId: 'fact-one', scopeId: 'scope', revision: 4, forgottenAt: '2026-10-04T09:20:00Z' };
}

function text(fixture: ComponentFixture<MemoryPanel>): string {
  return fixture.nativeElement.textContent as string;
}

function button(fixture: ComponentFixture<MemoryPanel>, name: string): HTMLButtonElement {
  const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
  const found = Array.from(buttons).find(buttonMatches.bind(null, name));
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

function buttonMatches(name: string, candidate: HTMLButtonElement): boolean {
  return candidate.textContent?.trim() === name;
}

function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); }
function closeModal(this: HTMLDialogElement): void { this.removeAttribute('open'); }

async function openDetail(kind: 'person' | 'group' | 'assistant_notes' = 'person',
  detail: unknown = { scopeId: 'scope', fact: savedFact, sources: [], canForget: true },
  postReply: Response = reply(200, receipt('pending')),
): Promise<{ fixture: ComponentFixture<MemoryPanel>; posts: string[] }> {
  const posts: string[] = [];
  async function fetchReply(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    if (url.endsWith('/scopes')) return reply(200, { scopes: [scope(kind)] });
    if (url.includes('/facts?')) return reply(200, { scopeId: 'scope', facts: [savedFact],
      returnedCount: 1, nextCursor: null });
    if (url.endsWith('/forget')) {
      posts.push(String(init?.body));
      return postReply;
    }
    if (url.endsWith('/facts/fact-one')) return reply(200, detail);
    if (url.includes('/changes/')) return reply(200, receipt('forgotten'));
    throw new Error('Unexpected request');
  }
  vi.stubGlobal('fetch', vi.fn(fetchReply));
  TestBed.configureTestingModule({ imports: [MemoryPanel] });
  const fixture = TestBed.createComponent(MemoryPanel);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain(privateText);
  });
  const factButton = fixture.nativeElement.querySelector('button.fact') as HTMLButtonElement;
  factButton.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toMatch(/Revision|no longer available/);
  });
  return { fixture, posts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

Object.assign(HTMLDialogElement.prototype, { showModal, close: closeModal });

it.each(['group', 'assistant_notes'] as const)('hides Forget in %s detail', async kind => {
  const { fixture } = await openDetail(kind);
  expect(() => button(fixture, 'Forget')).toThrow();
});

it('hides Forget when detail is unavailable', async () => {
  const detail = { status: 'unavailable', scopeId: 'scope', memoryId: 'fact-one',
    revision: 4, reason: 'forgotten' };
  const { fixture } = await openDetail('person', detail);
  expect(() => button(fixture, 'Forget')).toThrow();
});

it('reviews without fact text and Cancel sends no command', async () => {
  const { fixture, posts } = await openDetail();
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  const sheet = fixture.nativeElement.querySelector('oc-modal-sheet') as HTMLElement;
  expect(sheet.textContent).toContain('Forget this fact from your memory?');
  expect(sheet.textContent).toContain('Only you lose it from memory.');
  expect(sheet.textContent).not.toContain(privateText);
  button(fixture, 'Cancel').click();
  fixture.detectChanges();
  expect(posts).toHaveLength(0);
});

it('posts once and removes all fact text on a pending receipt', async () => {
  const { fixture, posts } = await openDetail();
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Hidden · cleanup pending');
  });
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0] ?? '')).toMatchObject({ expectedRevision: 3,
    commandId: expect.stringMatching(/^mem_[\da-f-]+$/) });
  expect(text(fixture)).not.toContain(privateText);
  expect(fixture.nativeElement.querySelector('[aria-live]')?.textContent).not.toContain(privateText);
  expect(location.href).not.toContain('fact-one');
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('shows conflict and offers a detail read without another POST', async () => {
  const { fixture, posts } = await openDetail('person', undefined,
    reply(409, { outcome: 'conflict' }));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Changed before you forgot it');
  });
  expect(posts).toHaveLength(1);
  expect(button(fixture, 'Review latest revision')).toBeDefined();
});

it('keeps a 503 outcome unknown and checks the same command only', async () => {
  const { fixture, posts } = await openDetail('person', undefined,
    reply(503, { status: 'unavailable' }));
  button(fixture, 'Forget').click();
  fixture.detectChanges();
  button(fixture, 'Forget from your memory').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Outcome unknown');
  });
  button(fixture, 'Check status').click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(text(fixture)).toContain('Forgotten');
  });
  expect(posts).toHaveLength(1);
  expect(text(fixture)).not.toContain(privateText);
});
