import { TestBed } from '@angular/core/testing';
import { ApprovalCards } from './approvals';

afterEach(() => { vi.restoreAllMocks(); });
it('restores pending review, submits only the decision and collapses the durable answer', async () => {
  let state = 'requested';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    if (init?.method === 'POST') { expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({ approvalId: 'a'.repeat(64), decision: 'approved' }); state = 'approved'; return Promise.resolve(new Response('{}')); }
    return Promise.resolve(new Response(JSON.stringify({ csrf: 'csrf', cards: [{ approvalId: 'a'.repeat(64), conversationId: 'chat', requesterId: 'me', expiresAt: '2026-10-04T12:00:00Z',
      state, canDecide: state === 'requested', stepUp: false, review: { action: 'Update order', tool: 'write', target: 'SO-2214', data: '{"note":"Hello"}', destination: 'https://erp.example.test', account: 'No account', consequence: 'The order changes immediately.' } }] })));
  });
  const fixture = TestBed.createComponent(ApprovalCards); fixture.componentRef.setInput('conversationId', 'chat'); await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('No root');
  const root = value;
  await vi.waitFor(() => expect(root.textContent).toContain('SO-2214')); expect(root.textContent).not.toContain('Sign in again');
  root.querySelector<HTMLButtonElement>('.approve')!.click(); await fixture.whenStable();
  expect(fetch).toHaveBeenCalled(); await vi.waitFor(() => expect(root.textContent).toContain('Approved'));
  expect(root.querySelector('.approval-ledger')).toBeNull();
  fixture.destroy();
  const restored = TestBed.createComponent(ApprovalCards); restored.componentRef.setInput('conversationId', 'chat'); await restored.whenStable();
  const element: unknown = restored.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(element.textContent).toContain('Approved'));
  expect(element.querySelector('.approve')).toBeNull();
});

it.each(['denied', 'expired', 'cancelled', 'outcome_unknown'])('restores %s as a collapsed card without decision controls', async state => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ csrf: 'csrf', cards: [{ approvalId: 'b'.repeat(64), conversationId: 'chat', requesterId: 'me', expiresAt: '2026-10-04T12:00:00Z',
    state, canDecide: false, stepUp: true, review: { action: 'Update order', tool: 'write', target: 'SO-2214', data: '{}', destination: 'https://erp.example.test', account: 'No account', consequence: 'Changes immediately.' } }] })));
  const fixture = TestBed.createComponent(ApprovalCards); fixture.componentRef.setInput('conversationId', 'chat');
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  await vi.waitFor(() => expect(root.querySelector('.terminal')).not.toBeNull());
  expect(root.querySelector('.approve')).toBeNull(); expect(root.querySelector('.approval-ledger')).toBeNull();
  expect(root.querySelector('a')).toBeNull();
});
