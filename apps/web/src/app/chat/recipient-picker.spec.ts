import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { RecipientPicker } from './recipient-picker';

const people = [
  { memberId: 'alex', displayName: 'Alex Kim' },
  { memberId: 'grace', displayName: 'Grace Achieng' },
  { memberId: 'peter', displayName: 'Peter Otieno' },
  { memberId: 'long', displayName: 'A very long colleague name that must wrap on a phone' },
];

function groupSnapshot() {
  return { groupId: 'sales', name: 'Sales team', position: 41, members: people };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function rootElement(fixture: ComponentFixture<RecipientPicker>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Picker root is not an element');
  return root;
}

async function createPicker(): Promise<ComponentFixture<RecipientPicker>> {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const response = requestUrl(input).endsWith('/sales')
      ? groupSnapshot()
      : { rows: [{ groupId: 'sales', name: 'Sales team' }], next: null };
    return Promise.resolve(new Response(JSON.stringify(response)));
  }));
  await TestBed.configureTestingModule({ imports: [RecipientPicker] }).compileComponents();
  const fixture = TestBed.createComponent(RecipientPicker);
  fixture.componentRef.setInput('colleagues', people);
  fixture.componentRef.setInput('query', '');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

it('shows an empty search state without creating a conversation', async () => {
  const fixture = await createPicker();
  fixture.componentRef.setInput('colleagues', []);
  fixture.componentRef.setInput('query', 'no match');
  fixture.detectChanges();
  const root = rootElement(fixture);
  expect(root.textContent).toContain('No colleagues match this search.');
  expect(root.querySelector('button.finish-selection')).toBeNull();
});

it.each(['loading', 'failed'] as const)('shows the %s colleague search state', async (state) => {
  const fixture = await createPicker();
  fixture.componentRef.setInput('searchState', state);
  fixture.detectChanges();
  const message = state === 'loading' ? 'Loading colleagues…' : 'Could not search colleagues.';
  expect(rootElement(fixture).textContent).toContain(message);
});

it('keeps long names in removable chips and reports a group selection', async () => {
  const fixture = await createPicker();
  const component = fixture.componentInstance;
  const selected = vi.fn();
  component.selectionChanged.subscribe(selected);
  const root = rootElement(fixture);
  const options = root.querySelectorAll<HTMLButtonElement>('.colleague-option');
  options[0]?.click();
  options[1]?.click();
  options[3]?.click();
  fixture.detectChanges();
  expect(root.querySelectorAll('.person-chip').length).toBe(3);
  expect(root.textContent).toContain('Group conversation');
  expect(selected).toHaveBeenLastCalledWith({ people: [people[0], people[1], people[3]] });
});

it('refuses to combine people with the separate assistant session flow', async () => {
  const fixture = await createPicker();
  const root = rootElement(fixture);
  root.querySelector<HTMLButtonElement>('.colleague-option')?.click();
  root.querySelector<HTMLButtonElement>('.assistant-choice')?.click();
  fixture.detectChanges();
  expect(root.textContent)
    .toContain('People and an assistant cannot share a new conversation.');
});

it('shows the saved member count and review position for a group snapshot', async () => {
  const fixture = await createPicker();
  const component = fixture.componentInstance;
  const root = rootElement(fixture);
  function groupsLoaded(): void {
    fixture.detectChanges();
    expect(root.querySelector('#own-group')).not.toBeNull();
  }
  await vi.waitFor(groupsLoaded);
  const select = root.querySelector<HTMLSelectElement>('#own-group');
  if (!select) throw new Error('Group selector is missing');
  select.value = 'sales';
  select.dispatchEvent(new Event('change'));
  await fixture.whenStable();
  fixture.detectChanges();
  expect(root.textContent).toContain('Sales team (4 people, as of now)');
  expect(component.snapshot()?.position).toBe(41);
  expect(root.querySelectorAll('.person-chip button').length).toBe(0);
});

it('shows an error when a manual audience would exceed the conversation limit', async () => {
  const fixture = await createPicker();
  fixture.componentInstance.people.set(new Array<{
    memberId: string; displayName: string | null;
  }>(97).fill(people[0]!));
  fixture.detectChanges();
  expect(rootElement(fixture).textContent)
    .toContain('A conversation can have no more than 97 people, including you.');
});
