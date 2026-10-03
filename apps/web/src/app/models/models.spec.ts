import { TestBed } from '@angular/core/testing';
import { ModelsScreen } from './models';

const budget = { sequence: 2, defaultPayingGroupId: 'personal-default', periodStart: '2026-10-01T00:00:00.000Z', todayCents: 1,
  monthCents: 1, reservedCents: 25, ceilingCents: 20000, dailyCeilingCents: 2000, ceilings: [] };
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());
it('sends integer cents, prevents duplicate saves, requires a fresh read after uncertainty and clears budget data on access loss', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { budget, models: [] }));
  const fixture = TestBed.createComponent(ModelsScreen); fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected screen');
  await vi.waitFor(() => expect(root.querySelector('fieldset')).not.toBeNull());
  const ceiling = root.querySelector<HTMLInputElement>('#monthly-ceiling')!;
  ceiling.value = '12345'; ceiling.dispatchEvent(new Event('input')); fixture.detectChanges();
  let finish!: (response: Response) => void;
  fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true })); fixture.detectChanges();
  expect(root.querySelector('fieldset')!.disabled).toBe(true);
  const sent = fetch.mock.calls.at(-1)?.[1]?.body;
  if (typeof sent !== 'string') throw new Error('Expected JSON command');
  expect(JSON.parse(sent) as unknown).toMatchObject({ scope: 'global', ceilingCents: 12345, expectedSequence: 2 });
  finish(reply(503)); await vi.waitFor(() => expect(root.textContent).toContain('Could not confirm'));
  expect(root.querySelector('fieldset')!.disabled).toBe(true);
  fetch.mockResolvedValueOnce(reply(403)); root.querySelector<HTMLButtonElement>('.refresh')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Access changed'));
  expect(root.querySelector('form')).toBeNull(); expect(root.textContent).not.toContain('personal-default');
});
