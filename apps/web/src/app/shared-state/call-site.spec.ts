import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { McpInstall } from '../mcp-install/mcp-install';
import { FilePreview } from '../chat/file-preview';
import { LiveView } from '../live-view/live-view';

function rootOf<T>(fixture: ComponentFixture<T>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing component root');
  return element;
}

function installDialogMethods<T>(fixture: ComponentFixture<T>): void {
  const dialog = rootOf(fixture).querySelector('dialog');
  if (!dialog) throw new Error('Missing dialog');
  dialog.showModal = vi.fn();
  dialog.close = vi.fn();
}

function rejectedCapture(status: number): Response {
  return new Response('{}', { status });
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it('maps a refused MCP address to Refused rather than Draft', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejectedCapture(400));
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const element = rootOf(fixture);
  const input = element.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('Missing source input');
  input.value = 'https://private.example/mcp';
  input.dispatchEvent(new Event('input'));
  element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  await fixture.whenStable();
  expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('refused');
  expect(element.querySelector('.message')?.textContent).toContain('This address was refused');
  expect(element.textContent).not.toContain('Draft');
});

it('shows a readable fallback for a loaded file with no rendered preview', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }),
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(function revoke() {});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true, writable: true, value: vi.fn(),
  });
  const fixture = TestBed.createComponent(FilePreview);
  fixture.componentRef.setInput('path', 'report.bin');
  fixture.componentRef.setInput('conversationId', 'chat');
  // Install jsdom's missing dialog methods before the after-render loader runs.
  fixture.detectChanges();
  installDialogMethods(fixture);
  await fixture.whenStable();
  const element = rootOf(fixture);
  function previewIsReady(): void {
    fixture.detectChanges();
    expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready');
  }
  await vi.waitFor(previewIsReady);
  expect(element.textContent).toContain('No rendered preview');
  expect(element.textContent).not.toContain('Not configured');
});

async function createView(): Promise<ComponentFixture<LiveView>> {
  const fixture = TestBed.createComponent(LiveView);
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.detectChanges();
  installDialogMethods(fixture);
  await fixture.whenStable();
  return fixture;
}

it('maps the initial disconnected view to Paused with only the specific words', async () => {
  const fixture = await createView();
  const status = rootOf(fixture).querySelector('[role=status]');
  expect(status?.querySelector('[data-state]')?.getAttribute('data-state')).toBe('paused');
  expect(status?.textContent?.trim()).toBe('Disconnected');
});

it.each([400, 403, 422, 503])('maps a definite capture rejection (%s) without unknown or retry',
  async function checkRejection(status) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejectedCapture(status));
    const fixture = await createView();
    fixture.componentInstance['state'].set('Viewing');
    await fixture.componentInstance['capture']();
    fixture.detectChanges();
    const expected = status === 403 || status === 422 ? 'refused' : 'failed';
    expect(fixture.componentInstance['captureKind']()).toBe(expected);
    expect(rootOf(fixture).textContent).not.toMatch(/Outcome unknown|Retry/u);
  },
);

it('keeps ambiguous captures unknown and asks for evidence before another attempt', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network lost'));
  const fixture = await createView();
  fixture.componentInstance['state'].set('Viewing');
  await fixture.componentInstance['capture']();
  fixture.detectChanges();
  expect(fixture.componentInstance['captureKind']()).toBe('unknown');
  expect(rootOf(fixture).textContent).toContain('Check the session files');
  expect(rootOf(fixture).textContent).not.toContain('Retry');
});

it('ignores a capture rejection after the view has closed', async () => {
  let rejectCapture!: (reason: Error) => void;
  function holdCapture(): Promise<Response> {
    function saveReject(_resolve: unknown, reject: (reason: Error) => void): void {
      rejectCapture = reject;
    }
    return new Promise<Response>(saveReject);
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(holdCapture);
  const fixture = await createView();
  fixture.componentInstance['state'].set('Viewing');
  const capture = fixture.componentInstance['capture']();
  fixture.componentInstance['close']('Disconnected');
  rejectCapture(new DOMException('Closed', 'AbortError'));
  await capture;
  expect(fixture.componentInstance['captureKind']()).toBe('checking');
  expect(fixture.componentInstance['captureStatus']()).not.toContain('unknown');
});

it('keeps an unconfirmed registration explicit after reload', () => {
  sessionStorage.setItem('mcp-registration', 'https://mcp.example/mcp');
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const element = rootOf(fixture);
  expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('unknown');
  expect(element.querySelector('.message')?.textContent).toContain('Outcome unknown');
  expect(element.textContent).toContain('Check status to restore your change');
});

it('keeps a definite rejection when the response detail cannot be read', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unreadable detail', { status: 422 }));
  const fixture = await createView();
  fixture.componentInstance['state'].set('Viewing');
  await fixture.componentInstance['capture']();
  fixture.detectChanges();
  expect(fixture.componentInstance['captureKind']()).toBe('refused');
  expect(rootOf(fixture).textContent).not.toContain('unknown');
});
