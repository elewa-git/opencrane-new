import { TestBed } from '@angular/core/testing';
import { ToolPolicyScreen } from './tool-policy';

const policy = { sequence: 12, connectionId: 'installed', accountMode: 'none', published: true,
  tools: [{ name: 'read', revision: 'a'.repeat(64), reviewed: true, readOnly: true, mode: 'block', suggestion: 'allow' }] };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

it('holds saves while pending, clears protected data on access change and requires a status read after failure', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, policy));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture'); fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  await vi.waitFor(() => expect(root.querySelector('fieldset')).not.toBeNull());
  expect(root.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready');
  expect(root.textContent).not.toContain('Needs input');
  const ask = root.querySelector<HTMLInputElement>('input[value="ask"]')!;
  ask.click(); fixture.detectChanges();
  let finish!: (response: Response) => void;
  fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  root.querySelector('button')!.click(); fixture.detectChanges();
  expect(root.textContent).toContain('Saving read'); expect(root.querySelector('fieldset')!.disabled).toBe(true);
  finish(reply(503));
  await vi.waitFor(() => expect(root.textContent).toContain('Could not confirm'));
  expect(root.querySelector('fieldset')!.disabled).toBe(true);
  fetch.mockResolvedValueOnce(reply(200, policy));
  root.querySelector('button')!.click();
  await vi.waitFor(() => expect(root.querySelector('fieldset')!.disabled).toBe(false));
  root.querySelector<HTMLInputElement>('input[value="ask"]')!.click(); fixture.detectChanges();
  fetch.mockResolvedValueOnce(reply(403)); root.querySelector('button')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Access changed'));
  expect(root.querySelector('fieldset')).toBeNull(); expect(root.querySelector('button')).toBeNull();
});

it('gives non-admins no enabled save or protected tool details', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(403));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture'); fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  await vi.waitFor(() => expect(root.textContent).toContain('Access changed'));
  expect(root.querySelector('input, button')).toBeNull();
});
