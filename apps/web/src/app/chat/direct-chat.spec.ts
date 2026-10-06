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
