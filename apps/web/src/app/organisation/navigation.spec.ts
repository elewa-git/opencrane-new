import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganisationShell } from './organisation-shell';
import { OverviewScreen } from './overview';
import { organisationPages, type OrganisationPage } from './pages';

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

function response(without?: string, role = 'admin'): Response {
  const body = { rows: [], next: null, allClear: false,
    sources: [{ name: 'people', status: 'current', checkedAt }],
    viewer: { role }, capabilities: capabilities(without) };
  return new Response(JSON.stringify(body));
}

@Component({
  imports: [OrganisationShell, OverviewScreen],
  template: `<oc-organisation-shell activePage="overview" [permittedPages]="permitted()"
    [accessLost]="lost()"><oc-overview (navigationReady)="permitted.set($event)"
    (accessLost)="lost.set(true)" /></oc-organisation-shell>`,
})
class NavigationHost {
  readonly permitted = signal<readonly OrganisationPage[]>([]);
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

function root(fixture: ComponentFixture<NavigationHost>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected navigation host');
  return element;
}

function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

function mockDialog(element: HTMLElement): void {
  const dialog = element.querySelector('dialog')!;
  Object.defineProperty(dialog, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(dialog, 'close', { configurable: true, value: closeDialog });
}

afterEach(() => vi.restoreAllMocks());

it.each([undefined, ...capabilityNames])('shows permitted desktop and phone links: %s',
  async (missing) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(missing));
    const fixture = await mount();
    const element = root(fixture);
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
  const element = root(fixture);
  expect(links(element.querySelector('.sidebar')!)).toEqual([]);
  finish(new Response('{}', { status: 503 }));
  await vi.waitFor(() => fixture.detectChanges());
  expect(links(element.querySelector('.sidebar')!)).toEqual([]);
});

it('keeps permitted links after a temporary failed refresh', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());
  const fixture = await mount();
  const element = root(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toHaveLength(7);
  });
  fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  element.querySelector<HTMLButtonElement>('.overview-heading button')!.click();
  await vi.waitFor(() => fixture.detectChanges());
  expect(links(element.querySelector('.sidebar')!)).toHaveLength(7);
});

it('closes an open menu when a successful read no longer grants admin access', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());
  const fixture = await mount();
  const element = root(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toHaveLength(7);
  });
  mockDialog(element);
  element.querySelector<HTMLButtonElement>('.mobile-bar button')!.click();
  fixture.detectChanges();
  expect(element.querySelector('dialog')?.open).toBe(true);
  fetchSpy.mockResolvedValueOnce(response(undefined, 'member'));
  element.querySelector<HTMLButtonElement>('.overview-heading button')!.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toEqual([]);
    expect(element.querySelector('dialog')?.open).toBe(false);
  });
});

it.each([401, 403])('clears links and closes the phone menu on %i', async (status) => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());
  const fixture = await mount();
  const element = root(fixture);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toHaveLength(7);
  });
  const opener = element.querySelector<HTMLButtonElement>('.mobile-bar button')!;
  mockDialog(element);
  opener.click();
  fixture.detectChanges();
  expect(element.querySelector('dialog')?.open).toBe(true);
  fetchSpy.mockResolvedValueOnce(new Response('{}', { status }));
  element.querySelector<HTMLButtonElement>('.overview-heading button')!.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(links(element.querySelector('.sidebar')!)).toEqual([]);
  });
  expect(element.querySelector('dialog')?.open).not.toBe(true);
});
