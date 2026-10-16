import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { McpInstall } from './mcp-install';

function screenRoot(fixture: ComponentFixture<McpInstall>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected add screen');
  return root;
}

function isRequestCall(value: unknown): value is [RequestInfo | URL, RequestInit | undefined] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const options: unknown = value[1];
  if (options === undefined) return true;
  return typeof options === 'object' && options !== null && 'body' in options;
}

function registrationLocator(call: unknown): string {
  if (!isRequestCall(call)) throw new Error('Expected a registration request');
  const requestOptions = call[1];
  if (!requestOptions || typeof requestOptions.body !== 'string') {
    throw new Error('Expected a JSON registration body');
  }
  const body: unknown = JSON.parse(requestOptions.body);
  if (typeof body !== 'object' || body === null || !('locator' in body)
    || typeof body.locator !== 'string') {
    throw new Error('Expected a server address in the registration body');
  }
  return body.locator;
}

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function discovery(state: 'checking' | 'needs_input' | 'failed', withInventory = false) {
  return {
    serverId: 'remote-id',
    changeRef: 'change-1',
    state,
    inventory: withInventory ? {
      schemaDigest: 'digest-1',
      serverInfo: { name: 'Remote server', version: '1.0' },
      tools: [{ name: 'read_item', revision: 'revision-1' }],
    } : undefined,
  };
}

beforeEach(() => {
  history.replaceState({}, '', '/org/integrations/new');
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

it('offers remote and package sources while the catalogue stays unavailable', () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(404));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="source"]')];
  expect(radios).toHaveLength(3);
  expect(radios[0]?.disabled).toBe(true);
  expect(radios[1]?.checked).toBe(true);
  expect(radios[2]?.disabled).toBe(false);
  expect(root.textContent).toContain('An exact image checked before it can run.');
  expect(root.querySelector('ol[aria-label="Add an integration steps"]')).not.toBeNull();
  expect(root.querySelector('nav[aria-label="Add an integration progress"]')).toBeNull();
  expect(root.querySelector('button[aria-label="Continue and discover tools"]')).not.toBeNull();
  fixture.destroy();
});

it('submits the address once when the person presses Enter', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, {
    changeRef: 'change-1',
  }));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  const address = root.querySelector<HTMLInputElement>('#remote-url');
  if (!address) throw new Error('Expected the server address field');
  address.value = 'https://remote.example.test/mcp';
  address.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(root.textContent).toContain('Validating the server'));
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
  fixture.destroy();
});

it('keeps the typed address after a lost registration reply and a failed check', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(503));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  const address = root.querySelector<HTMLInputElement>('#remote-url');
  if (!address) throw new Error('Expected the server address field');
  address.value = 'https://typed.example.test/mcp';
  address.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain(
    'We could not confirm the change. Check status before continuing.',
  ));
  root.querySelector<HTMLButtonElement>('.discovery-actions button')?.click();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(address.value).toBe('https://typed.example.test/mcp');
  expect(sessionStorage.getItem('mcp-registration')).toBe('https://typed.example.test/mcp');
  fixture.destroy();
});

it('creates two registrations in one visit with a new address each time', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, { changeRef: 'first-command' }))
    .mockResolvedValueOnce(reply(200, discovery('needs_input', true)))
    .mockResolvedValueOnce(reply(200, { changeRef: 'second-command' }));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  const address = root.querySelector<HTMLInputElement>('#remote-url');
  if (!address) throw new Error('Expected the server address field');
  address.value = 'https://first.example.test/mcp';
  address.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('Validating the server'));
  root.querySelector<HTMLButtonElement>('.discovery-actions button')?.click();
  await vi.waitFor(() => expect(root.querySelector('a.continue-tools')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('button.secondary:not(.cancel)')?.click();
  await vi.waitFor(() => expect(address.value).toBe(''));
  const secondAddress = root.querySelector<HTMLInputElement>('#remote-url');
  if (!secondAddress) throw new Error('Expected the second server address field');
  secondAddress.value = 'https://second.example.test/mcp';
  secondAddress.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST'))
    .toHaveLength(2));
  expect(registrationLocator(fetch.mock.calls[0])).toBe('https://first.example.test/mcp');
  expect(registrationLocator(fetch.mock.calls[2])).toBe('https://second.example.test/mcp');
  fixture.destroy();
});

it('links a discovered inventory to its tools page', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200,
    discovery('needs_input', true)));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('a.continue-tools')?.getAttribute('href'))
    .toBe('/org/integrations/remote-id/tools'));
});

it('does not offer tools when discovery needs a validation connection', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, {
    ...discovery('needs_input'),
    reason: 'connection_required',
  }));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('A scoped validation connection'));
  expect(root.querySelector('a.continue-tools')).toBeNull();
});

it('focuses the address after Add another server removes itself', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200,
    discovery('needs_input', true)));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('button.secondary:not(.cancel)'))
    .not.toBeNull());
  const anotherButton = root.querySelector<HTMLButtonElement>('button.secondary:not(.cancel)');
  anotherButton?.focus();
  anotherButton?.click();
  await vi.waitFor(() => expect(root.querySelector('#remote-url')).not.toBeNull());
  await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('#remote-url')));
  expect(document.activeElement).not.toBe(document.body);
  fixture.destroy();
});

it('focuses the address when a missing discovery reply returns to the form', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(404));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('No registration was found'));
  await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('#remote-url')));
  expect(document.activeElement).not.toBe(document.body);
  expect(fetch).toHaveBeenCalledTimes(1);
  fixture.destroy();
});

it('clears inventory and the saved address after access is refused', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, discovery('needs_input', true)))
    .mockResolvedValueOnce(reply(403));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('a.continue-tools')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  expect(root.querySelector('h1')?.textContent).toContain('Integrations');
  expect(root.textContent).not.toContain('Remote server · 1.0');
  expect(document.activeElement).toBe(root.querySelector('#integration-access-heading'));
  expect(sessionStorage.getItem('mcp-registration')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not show the source choice on the page for a registered server', async () => {
  history.replaceState({}, '', '/org/integrations/new?server=remote-id');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(503));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent)
    .toContain('Review MCP server'));
  expect(root.querySelector('fieldset.sources')).toBeNull();
  expect(root.textContent).not.toContain('Choose where the MCP server comes from.');
  fixture.destroy();
});

it('shows the admission heading and hides source choices after package submission', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(202,
    { serverId: 'server-1', changeRef: 'change-1' }));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root = screenRoot(fixture);
  const packageChoice = [...root.querySelectorAll<HTMLInputElement>('input[name="source"]')]
    .find(input => input.closest('label')?.textContent?.includes('Package (OCI image)'));
  packageChoice?.click();
  fixture.detectChanges();
  const locatorInput = root.querySelector<HTMLInputElement>('#image-locator');
  const hostInput = root.querySelector<HTMLInputElement>('#upstream-host');
  if (!locatorInput || !hostInput) throw new Error('Expected package form');
  locatorInput.value = `registry.example.com/team/clock@sha256:${'a'.repeat(64)}`;
  locatorInput.dispatchEvent(new Event('input', { bubbles: true }));
  hostInput.value = 'api.github.com';
  hostInput.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')?.requestSubmit();
  await vi.waitFor(() => expect(root.textContent).toContain('Registration saved'));
  expect(root.querySelector('#add-heading')?.textContent).toContain('Package admission');
  expect(root.querySelector('fieldset.sources')).toBeNull();
  fixture.destroy();
});
