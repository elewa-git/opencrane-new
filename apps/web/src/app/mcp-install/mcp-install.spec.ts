import { TestBed } from '@angular/core/testing';
import { McpInstall } from './mcp-install';

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

it('offers only the remote URL source and names the unavailable choices', () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(404));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected add screen');
  const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="source"]')];
  expect(radios).toHaveLength(3);
  expect(radios[0]?.disabled).toBe(true);
  expect(radios[1]?.checked).toBe(true);
  expect(radios[2]?.disabled).toBe(true);
  expect(root.textContent).toContain('Not available yet. Hosted packages need admission checks first.');
  expect(root.querySelector('ol[aria-label="Add an integration steps"]')).not.toBeNull();
  fixture.destroy();
});

it('links a discovered inventory to its tools page', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200,
    discovery('needs_input', true)));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected add screen');
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
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected add screen');
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.textContent).toContain('A scoped validation connection'));
  expect(root.querySelector('a.continue-tools')).toBeNull();
});

it('clears inventory and the saved address after access is refused', async () => {
  sessionStorage.setItem('mcp-registration', 'https://remote.example.test/mcp');
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, discovery('needs_input', true)))
    .mockResolvedValueOnce(reply(403));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected add screen');
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('a.continue-tools')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  expect(root.textContent).not.toContain('Remote server · 1.0');
  expect(document.activeElement).toBe(root.querySelector('#integration-access-heading'));
  expect(sessionStorage.getItem('mcp-registration')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
