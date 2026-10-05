import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { PeopleScreen } from './people-screen';

const sampleGroup = {
  groupId: 'sales-team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'sales-team', members: [{ memberId: 'alex-kim', displayName: 'Alex Kim',
    membershipSource: 'local' }], access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [] },
};
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
async function mount(body: unknown): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(body)));
  TestBed.configureTestingModule({ imports: [PeopleScreen] });
  const fixture = TestBed.createComponent(PeopleScreen);
  fixture.componentRef.setInput('organisationName', 'Example organisation');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading groups…');
  });
  return rootElement(fixture);
}
function rootElement(fixture: ComponentFixture<PeopleScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a screen element');
  return element;
}

it('shows typed rows with one link per group and one status region', async () => {
  const root = await mount({ rows: [sampleGroup] });
  const item = root.querySelector('[aria-label="Groups"] li');
  expect(item?.querySelectorAll('a')).toHaveLength(1);
  expect(item?.textContent).toContain('Sales team');
  expect(item?.textContent).toContain('1 member');
  expect(item?.textContent).toContain('Local · managed in OpenCrane');
  expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
  vi.unstubAllGlobals();
});

it('rejects a group that claims access to private conversations', async () => {
  const unsafe = { ...sampleGroup, access: { ...sampleGroup.access, conversationAccess: true } };
  const root = await mount({ rows: [unsafe] });
  expect(root.textContent).toContain('Groups are unavailable right now');
  expect(root.querySelector('[aria-label="Groups"]')).toBeNull();
  vi.unstubAllGlobals();
});

it('shows the empty list and keeps New group available', async () => {
  const root = await mount({ rows: [] });
  expect(root.textContent).toContain('No groups yet');
  expect(root.querySelector('.page-actions .button.primary')?.textContent).toContain('New group');
  vi.unstubAllGlobals();
});
