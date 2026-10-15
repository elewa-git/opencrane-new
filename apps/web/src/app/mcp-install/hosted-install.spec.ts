import { TestBed } from '@angular/core/testing';
import { HostedInstall } from './hosted-install';

const digest = 'a'.repeat(64);
const locator = `registry.example.com/team/clock@sha256:${digest}`;
const date = '2026-10-15T10:00:00.000Z';
const expiry = '2026-10-16T10:00:00.000Z';

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function check(verdict: 'pass' | 'not_run' | 'unavailable') {
  if (verdict === 'not_run') return { verdict };
  return { verdict, checkedAt: date, expiresAt: expiry, engineVersion: 'fixture',
    reportDigest: digest, databaseDigest: digest, databaseUpdatedAt: date };
}

function admission(verdict: 'pass' | 'not_run' | 'unavailable', status = 'checking') {
  return { serverId: 'server-1', attemptId: 1, imageDigest: digest,
    platform: 'linux/amd64', queuedAt: date, status,
    checks: { signature: check(verdict), licence: check(verdict),
      vulnerability: check(verdict), malware: check(verdict) } };
}

function screen() {
  const fixture = TestBed.createComponent(HostedInstall);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function fill(root: HTMLElement, field: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`#${field}`);
  if (!input) throw new Error(`Missing ${field}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
  const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ kind: 'hosted', locator, platform: 'linux/amd64',
    upstream: { host: 'api.github.com', port: 443 } });
  expect(body.commandId).toEqual(expect.any(String));
});

it('uses only the original command status GET after a lost reply', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, { status: 'unknown' }));
  const root = screen();
  validForm(root);
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('outcome is unknown'));
  const commandId = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).commandId;
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/org/integrations/changes/${commandId}`);
  expect(fetch.mock.calls[1]?.[1]?.method).toBeUndefined();
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
    await vi.waitFor(() => expect(root.querySelector('#hosted-check-status')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain('15 Oct 2026'));
    expect(root.textContent).toContain(verdict === 'not_run' ? 'Not run' :
      verdict === 'pass' ? 'Passed' : 'Unavailable');
    expect(root.querySelector<HTMLButtonElement>('#hosted-continue')?.disabled).toBe(true);
    expect(root.textContent).toContain('No person or assistant has access');
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
  await vi.waitFor(() => expect(root.textContent).toContain('unavailable'));
  root.querySelector<HTMLButtonElement>('#hosted-check-status')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('no longer have permission'));
  expect(root.textContent).not.toContain(locator);
  expect(fetch).toHaveBeenCalledTimes(3);
});
