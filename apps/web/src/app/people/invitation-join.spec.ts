import { TestBed } from '@angular/core/testing';
import { App } from '../app';

const path = '/join/a-member/an-invitation';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function applicationElement(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Missing application');
  return value;
}

async function openInvitation(control: string) {
  TestBed.configureTestingModule({ imports: [App] });
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
  const { element, fixture } = await openInvitation('input[name=displayName]');
  accept(element);
  await vi.waitFor(function showsWorkspace() {
    fixture.detectChanges();
    expect(element.querySelector('a[href="/workspace"]')?.textContent?.trim()).toBe('Open workspace');
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
