import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';
import { GroupDetailScreen } from './group-detail-screen';

const group = {
  groupId: 'sales-team', name: 'Sales team', membershipSource: 'local', position: 0,
  payingGroupId: 'sales-team', members: [
    { memberId: 'alex-kim', displayName: 'Alex Kim', membershipSource: 'local' },
    { memberId: 'marieke-vos', displayName: 'Marieke Vos', membershipSource: 'identity_provider' },
  ], access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [
      { resourceType: 'model', resourceId: 'model-a', relation: 'use' },
      { resourceType: 'assistant', resourceId: 'assistant-a', relation: 'acts_for' },
    ] },
};
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
async function mount(reply: Response): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply));
  TestBed.configureTestingModule({ imports: [GroupDetailScreen] });
  const fixture = TestBed.createComponent(GroupDetailScreen);
  fixture.componentRef.setInput('groupId', 'sales-team');
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(rootElement(fixture).textContent).not.toContain('Loading group…');
  });
  return rootElement(fixture);
}
function rootElement(fixture: ComponentFixture<GroupDetailScreen>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected a detail screen element');
  return element;
}

it('shows separate shared-assistant and use-grant cards without a Remove button', async () => {
  const root = await mount(response({ rows: [group] }));
  expect(root.textContent).toContain('assistant-a');
  expect(root.textContent).toContain('Works for this group');
  expect(root.textContent).toContain('Can use model model-a');
  expect(root.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(0);
  expect(root.textContent?.indexOf('Alex Kim')).toBeLessThan(root.textContent?.indexOf('Marieke Vos'));
  vi.unstubAllGlobals();
});

it('clears a protected group after access is refused', async () => {
  const root = await mount(response({ status: 'refused' }, 403));
  expect(root.querySelector('h1')?.textContent).toBe('Group details');
  expect(root.textContent).toContain('Your access changed');
  expect(root.textContent).not.toContain('Sales team');
  expect(root.textContent).not.toContain('Alex Kim');
  vi.unstubAllGlobals();
});

it('shows an explicit empty state when a group has no members', async () => {
  const emptyGroup = { ...group, members: [], access: { ...group.access, grants: [] } };
  const root = await mount(response({ rows: [emptyGroup] }));
  expect(root.textContent).toContain('No members yet');
  expect(root.querySelector('ul.members')).toBeNull();
});

it('shows a safe retry action when the group read is unavailable', async () => {
  const root = await mount(response({ status: 'unavailable' }, 503));
  expect(root.textContent).toContain('Groups are unavailable right now');
  expect(root.textContent).toContain('Nothing changed. Reading again is safe.');
  expect(root.querySelector('[aria-label^="Remove "]')).toBeNull();
});
