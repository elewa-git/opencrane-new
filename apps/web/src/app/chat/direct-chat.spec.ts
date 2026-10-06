import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectChat } from './direct-chat';

function colleaguesReply(): Response {
  return new Response(JSON.stringify({ rows: [
    { memberId: 'grace', displayName: 'Grace Achieng' },
    { memberId: 'chris', displayName: 'Chris Njeri' },
  ], next: null }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function mount(): Promise<ComponentFixture<DirectChat>> {
  history.replaceState({}, '', '/workspace/direct');
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(colleaguesReply())));
  TestBed.configureTestingModule({ imports: [DirectChat] });
  const fixture = TestBed.createComponent(DirectChat);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await vi.waitFor(() => expect(root(fixture).textContent).toContain('Grace Achieng'));
  return fixture;
}

function root(fixture: ComponentFixture<DirectChat>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected the direct-chat screen');
  return element;
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('searches the colleague directory and keeps one selected person in the To line', async () => {
  const fixture = await mount();
  const row = [...root(fixture).querySelectorAll<HTMLButtonElement>('.colleague-row')]
    .find((button) => button.textContent?.includes('Grace Achieng'));
  if (!row) throw new Error('Expected a colleague row');
  row.click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root(fixture).textContent).toContain('ToGrace Achieng Change');
  expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(0);
  expect(root(fixture).querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  fixture.destroy();
});

it('returns focus to colleague search when the selected person is changed', async () => {
  const fixture = await mount();
  root(fixture).querySelector<HTMLButtonElement>('.colleague-row')?.click();
  fixture.detectChanges();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  root(fixture).querySelector<HTMLButtonElement>('.change-button')?.click();
  fixture.detectChanges();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(document.activeElement).toBe(root(fixture).querySelector('#colleague-search'));
  fixture.destroy();
});

function searchFor(fixture: ComponentFixture<DirectChat>, query: string): void {
  const field = root(fixture).querySelector<HTMLInputElement>('#colleague-search');
  if (!field) throw new Error('Expected colleague search');
  field.value = query;
  field.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

async function failedSearchIsVisible(status: number): Promise<void> {
  const fixture = await mount();
  function refuseSearch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status }));
  }
  vi.stubGlobal('fetch', vi.fn(refuseSearch));
  searchFor(fixture, 'gr');
  await fixture.whenStable();
  fixture.detectChanges();
  const panel = root(fixture).querySelector('.recipient-panel');
  expect(panel?.textContent).toContain('Could not search colleagues. Try again.');
  expect(panel?.textContent).not.toContain('No colleagues match');
  expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(0);
  fixture.destroy();
}

async function showsUnavailableSearch(): Promise<void> {
  await failedSearchIsVisible(503);
}
it('shows a visible search failure after a 503', showsUnavailableSearch);

async function showsRefusedSearch(): Promise<void> {
  await failedSearchIsVisible(403);
}
it('shows a visible search failure after a refused read', showsRefusedSearch);

async function ignoresOlderSearchReply(): Promise<void> {
  const fixture = await mount();
  let releaseOlder: ((response: Response) => void) | undefined;
  function holdOlder(resolve: (response: Response) => void): void {
    releaseOlder = resolve;
  }
  const olderReply = new Promise<Response>(holdOlder);
  function searchReply(input: string): Promise<Response> {
    if (input.includes('q=g&')) return olderReply;
    const data = { rows: [{ memberId: 'grace', displayName: 'Grace Achieng' }], next: null };
    return Promise.resolve(new Response(JSON.stringify(data)));
  }
  vi.stubGlobal('fetch', vi.fn(searchReply));
  searchFor(fixture, 'g');
  searchFor(fixture, 'gr');
  function newerReplyIsShown(): void {
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(1);
  }
  await vi.waitFor(newerReplyIsShown);
  if (!releaseOlder) throw new Error('Expected the older request');
  releaseOlder(colleaguesReply());
  function nextTask(resolve: () => void): void {
    setTimeout(resolve, 0);
  }
  await new Promise<void>(nextTask);
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root(fixture).querySelectorAll('.colleague-row')).toHaveLength(1);
  expect(root(fixture).textContent).not.toContain('Chris Njeri');
  fixture.destroy();
}
it('ignores an older search reply that arrives after the newer reply', ignoresOlderSearchReply);
