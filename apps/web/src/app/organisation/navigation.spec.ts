import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganisationShell } from './organisation-shell';
import { OverviewScreen } from './overview';
import { organisationPages } from './pages';

const capabilityNames = ['people', 'providers', 'spending', 'integrations',
  'routines', 'changeHistory'] as const;
const checkedAt = '2026-11-08T09:40:00.000Z';

function capabilities(without?: string) {
  return {
    people: { read: without !== 'people' },
    providers: { read: without !== 'providers' },
    spending: { read: without !== 'spending' },
    integrations: { read: without !== 'integrations' },
    routines: { readOwn: without !== 'routines' },
    changeHistory: { read: without !== 'changeHistory' },
  };
}

function response(without?: string): Response {
  const body = { rows: [], next: null, allClear: false,
    sources: [{ name: 'people', status: 'current', checkedAt }],
    viewer: { role: 'admin' }, capabilities: capabilities(without) };
  return new Response(JSON.stringify(body));
}

@Component({
  imports: [OrganisationShell, OverviewScreen],
  template: `<oc-organisation-shell activePage="overview" [permittedPages]="permitted()"
    [accessLost]="lost()"><oc-overview (navigationReady)="permitted.set($event)"
    (accessLost)="lost.set(true)" /></oc-organisation-shell>`,
})
class NavigationHost {
  readonly permitted = signal<readonly string[]>([]);
  readonly lost = signal(false);
}

async function mount() {
  TestBed.configureTestingModule({ imports: [NavigationHost] });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(NavigationHost);
  fixture.detectChanges();
  await vi.waitFor(() => fixture.detectChanges());
  return fixture;
}

function links(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLAnchorElement>('nav a')]
    .map((link) => link.textContent?.trim() ?? '');
}

afterEach(() => vi.restoreAllMocks());

it.each([undefined, ...capabilityNames])('shows permitted desktop and phone links: %s',
  async (missing) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(missing));
    const fixture = await mount();
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(links(element.querySelector('.sidebar')!)).toHaveLength(7 - Number(!!missing));
    });
    const expected = organisationPages.filter((page) => page.id !== (
      missing === 'providers' ? 'models' : missing === 'changeHistory' ? 'history' : missing));
    expect(links(element.querySelector('.sidebar')!)).toEqual(expected.map((page) => page.label));
    expect(links(element.querySelector('oc-navigation-menu')!)).toEqual(
      [...expected.map((page) => page.label), '‹ Back to workspace']);
    expect(element.querySelector('.sidebar a[aria-current="page"]')?.textContent?.trim())
      .toBe('Overview');
  });

it('hides protected links while loading and keeps them hidden after a 503', async () => {
  let finish!: (value: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
    finish = resolve;
  }));
  const fixture = await mount();
  const element: HTMLElement = fixture.nativeElement;
  expect(links(element.querySelector('.sidebar')!)).toEqual([]);
  finish(new Response('{}', { status: 503 }));
  await vi.waitFor(() => fixture.detectChanges());
  expect(links(element.querySelector('.sidebar')!)).toEqual([]);
});

it.each([401, 403])('clears links and closes the phone menu on %i', async (status) => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());
  const fixture = await mount();
  const element: HTMLElement = fixture.nativeElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toHaveLength(7);
  });
  const opener = element.querySelector<HTMLButtonElement>('.mobile-bar button')!;
  opener.click();
  fixture.detectChanges();
  expect(element.querySelector('dialog')?.open).toBe(true);
  fetchSpy.mockResolvedValueOnce(new Response('{}', { status }));
  element.querySelector<HTMLButtonElement>('.overview-heading button')!.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toEqual([]);
  });
  expect(element.querySelector('dialog')?.open).toBe(false);
});
