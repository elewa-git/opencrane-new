import { TestBed } from '@angular/core/testing';
import { App } from '../app';
import { NAVIGATE } from '../core/navigate';

const path = '/join/a-member/an-invitation';
const navigate = vi.fn();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function applicationElement(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Missing application');
  return value;
}

async function openInvitation(control: string) {
  TestBed.configureTestingModule({
    imports: [App], providers: [{ provide: NAVIGATE, useValue: navigate }],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  const element = applicationElement(fixture.nativeElement);
  function showsControl() {
    fixture.detectChanges();
    expect(element.querySelector(control)).not.toBeNull();
  }
  await vi.waitFor(showsControl);
  return { element, fixture };
}

function accept(element: HTMLElement): void {
  const name = element.querySelector<HTMLInputElement>('input[name=displayName]');
  const submit = element.querySelector<HTMLButtonElement>('button[type=submit]');
  if (!name || !submit) throw new Error('Missing invitation form');
  name.value = 'Pilot member';
  submit.click();
}

beforeEach(function openLink() {
  navigate.mockReset();
  globalThis.history.replaceState({}, '', path);
});

afterEach(function resetLink() {
  vi.restoreAllMocks();
  globalThis.history.replaceState({}, '', '/');
});

it('signs in with a return path to the original invitation', async function signInFromInvitation() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply({ authenticated: false }));
  const { element } = await openInvitation('a[href^="/auth/login"]');
  const link = element.querySelector<HTMLAnchorElement>('a[href^="/auth/login"]');
  expect(link?.textContent?.trim()).toBe('Sign in to accept');
  expect(new URL(link!.href).searchParams.get('returnTo')).toBe(path);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('accepts the invitation as the signed-in person', async function acceptInvitation() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply({ authenticated: true }));
  fetchSpy.mockResolvedValueOnce(reply({ status: 'joined' }));
  fetchSpy.mockResolvedValueOnce(reply({ next: 'survey' }));
  const { element } = await openInvitation('input[name=displayName]');
  accept(element);
  await vi.waitFor(function opensSurvey() {
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/welcome/survey');
  });
  const request = fetchSpy.mock.calls[1];
  expect(request?.[0]).toBe('/members/join');
  expect(request?.[1]?.method).toBe('POST');
  const body = request?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Missing invitation command');
  const command: unknown = JSON.parse(body);
  if (typeof command !== 'object' || !command || !('commandId' in command)) {
    throw new Error('Missing invitation command ID');
  }
  expect(command.commandId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(command).toMatchObject({
    memberId: 'a-member', invitationId: 'an-invitation', displayName: 'Pilot member',
  });
});

it('keeps a wrong account out of the workspace', async function refuseWrongAccount() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply({ authenticated: true }));
  fetchSpy.mockResolvedValueOnce(reply({ status: 'refused', reason: 'wrong_identity' }, 409));
  const { element, fixture } = await openInvitation('input[name=displayName]');
  accept(element);
  await vi.waitFor(function showsRefusal() {
    fixture.detectChanges();
    expect(element.querySelector('[role=alert]')?.textContent)
      .toContain('Sign in with the account this invitation was sent to.');
  });
  expect(element.querySelector('a[href="/workspace"]')).toBeNull();
});

it('requests fresh authentication when the provider session is old', async function refresh() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply({ authenticated: true }));
  fetchSpy.mockResolvedValueOnce(reply({ status: 'refused', reason: 'sign_in_again' }, 403));
  const { element, fixture } = await openInvitation('input[name=displayName]');
  accept(element);

  await vi.waitFor(function showsFreshSignIn() {
    fixture.detectChanges();
    const link = element.querySelector<HTMLAnchorElement>('a[href^="/auth/login"]');
    expect(link?.textContent?.trim()).toBe('Sign in again to accept');
    const address = new URL(link!.href);
    expect(address.searchParams.get('fresh')).toBe('1');
    expect(address.searchParams.get('returnTo')).toBe(path);
  });
});

function stallRequest(_resource: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const signal = options?.signal;
  return new Promise(function waitForAbort(_resolve, reject) {
    function abort() {
      reject(new DOMException('Deadline passed', 'TimeoutError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function controlDeadline() {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(function timeout(milliseconds) {
    expect(milliseconds).toBeGreaterThan(0);
    expect(milliseconds).toBeLessThanOrEqual(15_000);
    return deadline.signal;
  });
  return deadline;
}

it('ends the session check when the reply stalls', async function boundSessionCheck() {
  const deadline = controlDeadline();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementationOnce(stallRequest);
  const { element, fixture } = await openInvitation('[role=status]');
  const options = fetchSpy.mock.calls[0]?.[1];
  expect(options?.signal).toBe(deadline.signal);
  deadline.abort();

  await vi.waitFor(function showsCheckFailure() {
    fixture.detectChanges();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('Reload this page');
  });
});

it('retries a lost join reply with the original command', async function retryJoin() {
  const deadline = controlDeadline();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(reply({ authenticated: true }));
  fetchSpy.mockImplementationOnce(stallRequest);
  fetchSpy.mockResolvedValueOnce(reply({ status: 'already_joined' }));
  const { element, fixture } = await openInvitation('input[name=displayName]');
  accept(element);
  const sent = fetchSpy.mock.calls[1]?.[1];
  expect(sent?.signal).toBe(deadline.signal);
  deadline.abort();
  await vi.waitFor(function allowsRetry() {
    fixture.detectChanges();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('Try again');
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
  });

  accept(element);
  await vi.waitFor(function showsWorkspace() {
    fixture.detectChanges();
    expect(element.querySelector('a[href="/workspace"]')).not.toBeNull();
  });
  const repeated = fetchSpy.mock.calls[2]?.[1];
  expect(typeof sent?.body).toBe('string');
  expect(repeated?.body).toBe(sent?.body);
});
