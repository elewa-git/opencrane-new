import { TestBed } from '@angular/core/testing';
import { HostedInstall } from './hosted-install';
import { z } from 'zod';

const digest = 'a'.repeat(64);
const locator = `registry.example.com/team/clock@sha256:${digest}`;
const date = new Date(Date.now() - 60_000).toISOString();
const expiry = new Date(Date.now() + 3_600_000).toISOString();
const dateLabel = new Date(date).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function check(verdict: 'pass' | 'not_run' | 'unavailable', database = false) {
  if (verdict === 'not_run') return { verdict };
  const base = { verdict, checkedAt: date, expiresAt: expiry, engineVersion: 'fixture',
    reportDigest: digest };
  if (database) return { ...base, databaseDigest: digest, databaseUpdatedAt: date };
  return base;
}

function admission(verdict: 'pass' | 'not_run' | 'unavailable', status = 'checking') {
  return { serverId: 'server-1', attemptId: 1, imageDigest: digest,
    platform: 'linux/amd64', queuedAt: date, status,
    checks: { signature: check(verdict), licence: check(verdict),
      vulnerability: check(verdict, true), malware: check(verdict, true) } };
}

function screen() {
  const fixture = TestBed.createComponent(HostedInstall);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected package form');
  return root;
}

const registrationBodySchema = z.object({
  kind: z.literal('hosted'), locator: z.string(), platform: z.string(),
  upstream: z.object({ host: z.string(), port: z.number() }), commandId: z.string(),
});

function registrationBody(options: RequestInit | undefined) {
  if (!options || typeof options.body !== 'string') {
    throw new Error('Expected a JSON registration body');
  }
  const raw: unknown = JSON.parse(options.body);
  return registrationBodySchema.parse(raw);
}

function fill(root: HTMLElement, field: string, value: string) {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${field}`);
  if (!input) throw new Error(`Missing ${field}`);
  input.value = value;
  const eventName = input instanceof HTMLSelectElement ? 'change' : 'input';
  input.dispatchEvent(new Event(eventName, { bubbles: true }));
}

function validForm(root: HTMLElement) {
  fill(root, 'image-locator', locator);
  fill(root, 'upstream-host', 'api.github.com');
  fill(root, 'upstream-port', '443');
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('submits only a pinned digest, supported platform and checked upstream once', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(202,
    { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }));
  const root = screen();
  fill(root, 'image-locator', 'registry.example.com/team/clock:latest');
  fill(root, 'upstream-host', 'localhost');
  fill(root, 'upstream-port', '0');
  root.querySelector('form')?.requestSubmit();
  expect(fetch).not.toHaveBeenCalled();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const body = registrationBody(fetch.mock.calls[0]?.[1]);
  expect(body).toMatchObject({ kind: 'hosted', locator, platform: 'linux/amd64',
    upstream: { host: 'api.github.com', port: 443 } });
  expect(body.commandId).toEqual(expect.any(String));
});

it.each([
  ['mutable tag', 'image-locator', 'registry.example.com/team/clock:latest'],
  ['private upstream', 'upstream-host', 'localhost'],
  ['invalid port', 'upstream-port', '65536'],
  ['unsupported platform', 'image-platform', 'linux/ppc64'],
])('refuses %s before POST', (_name, field, value) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(202));
  const root = screen();
  validForm(root);
  fill(root, field, value);
  root.querySelector('form')?.requestSubmit();
  expect(fetch).not.toHaveBeenCalled();
});

it('uses only the original command status GET after a lost reply', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, { status: 'unknown' }));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('outcome is unknown'));
  const commandId = registrationBody(fetch.mock.calls[0]?.[1]).commandId;
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/org/integrations/changes/${commandId}`);
  expect(fetch.mock.calls[1]?.[1]?.method).toBeUndefined();
});

it('shows the queue time without inventing any check verdict', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
    { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }))
    .mockResolvedValueOnce(reply(200, { serverId: 'server-1', attemptId: 1,
      imageDigest: digest, platform: 'linux/amd64', queuedAt: date, status: 'checking' }));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.querySelector('#hosted-check-status')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain(`Queued ${dateLabel}`));
  expect(root.textContent?.match(/No result reported/gu)).toHaveLength(4);
});

it.each(['not_run', 'unavailable', 'pass'] as const)(
  'shows returned %s checks and dates without enabling Continue', async verdict => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
      { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }))
      .mockResolvedValueOnce(reply(200, admission(verdict,
        verdict === 'pass' ? 'admitted' : 'checking')));
    const root = screen();
    validForm(root);
    root.querySelector('form')?.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(
      '#hosted-check-status')?.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain(dateLabel));
    expect(root.textContent).toContain(verdict === 'not_run' ? 'Not run' :
      verdict === 'pass' ? 'Passed' : 'Unavailable');
    expect(root.querySelector<HTMLButtonElement>('#hosted-continue')?.disabled).toBe(true);
    expect(root.textContent).toContain('No person or assistant gained access');
    expect(root.textContent).toContain('Discovery is unavailable');
  });

it('keeps a safe read retry and clears protected content after access loss', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
    { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }))
    .mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(403));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.querySelector('#hosted-check-status')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Status is unavailable'));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(
    '#hosted-check-status')?.disabled).toBe(false));
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('no longer have permission'));
  expect(root.textContent).not.toContain(locator);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('removes earlier pass rows when a later admission read is unavailable', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
    { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }))
    .mockResolvedValueOnce(reply(200, admission('pass', 'admitted')))
    .mockResolvedValueOnce(reply(503));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.querySelector('#hosted-check-status')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('All four image checks passed'));
  await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(
    '#hosted-check-status')?.disabled).toBe(false));
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Status is unavailable'));
  expect(root.textContent).not.toContain('Passed');
  expect(root.querySelector<HTMLButtonElement>('#hosted-check-status')?.disabled).toBe(false);
});

it('labels an expired pass as expired and keeps Continue disabled', async () => {
  const oldExpiry = new Date(Date.now() - 1_000).toISOString();
  const expired = { ...admission('pass', 'admitted'), checks: {
    signature: { ...check('pass'), expiresAt: oldExpiry },
    licence: { ...check('pass'), expiresAt: oldExpiry },
    vulnerability: { ...check('pass', true), expiresAt: oldExpiry },
    malware: { ...check('pass', true), expiresAt: oldExpiry },
  } };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
    { status: 'appended', serverId: 'server-1', changeRef: 'chg_command-1' }))
    .mockResolvedValueOnce(reply(200, expired));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.querySelector('#hosted-check-status')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Expired'));
  expect(root.textContent).not.toContain('All four image checks passed');
  expect(root.querySelector<HTMLButtonElement>('#hosted-continue')?.disabled).toBe(true);
});

it('expires all four pass rows and the summary while the page is idle', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    vi.setSystemTime(Date.parse(expiry) - 1_000);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(202,
      { serverId: 'server-1', changeRef: 'change-1' }))
      .mockResolvedValueOnce(reply(200, admission('pass', 'admitted')));
    const fixture = TestBed.createComponent(HostedInstall);
    fixture.detectChanges();
    const root: unknown = fixture.nativeElement;
    if (!(root instanceof HTMLElement)) throw new Error('Expected package form');
    validForm(root);
    root.querySelector('form')?.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(
      '#hosted-check-status')?.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
    await vi.waitFor(() => expect(root.textContent?.match(/Passed/gu)).toHaveLength(4));
    expect(root.textContent).toContain('All four image checks passed');

    await vi.advanceTimersByTimeAsync(1_001);
    await fixture.whenStable();
    expect(root.textContent?.match(/Expired/gu)).toHaveLength(4);
    expect(root.textContent).not.toContain('All four image checks passed');
    expect(root.querySelector<HTMLButtonElement>('#hosted-continue')?.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    fixture.destroy();
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a punycode host before posting', () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(202));
  const root = screen();
  validForm(root);
  fill(root, 'upstream-host', 'xn--a.com');
  root.querySelector('form')?.requestSubmit();
  expect(fetch).not.toHaveBeenCalled();
});

it('normalises an uppercase public host before posting', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(202,
    { serverId: 'server-1', changeRef: 'change-1' }));
  const root = screen();
  validForm(root);
  fill(root, 'upstream-host', 'API.GITHUB.COM');
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(registrationBody(fetch.mock.calls[0]?.[1]).upstream.host).toBe('api.github.com');
});

it('keeps package details editable after a definitive 400 rejection', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(400));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('correct the package details'));
  expect(root.querySelector<HTMLInputElement>('#image-locator')?.value).toBe(locator);
  expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});
