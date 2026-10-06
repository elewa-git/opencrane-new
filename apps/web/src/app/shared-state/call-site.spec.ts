import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { McpInstall } from '../mcp-install/mcp-install';
import { FilePreview } from '../chat/file-preview';

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
  const input = element.querySelector<HTMLInputElement>('#remote-url');
  if (!input) throw new Error('Missing source input');
  input.value = 'https://private.example/mcp';
  input.dispatchEvent(new Event('input'));
  element.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
  await fixture.whenStable();
  expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('refused');
  expect(element.querySelector('.message')?.textContent).toContain('This address was refused');
  expect(element.textContent).not.toContain('Draft');
  expect(input.disabled).toBe(false);
  expect(element.textContent).not.toContain('Check status');
});

it.each(['button', 'form'])('submits an edited refused address through the %s',
  async function submitCorrectedAddress(submission) {
    const acceptedChange = { changeRef: 'corrected-change' };
    const acceptedBody = JSON.stringify(acceptedChange);
    const acceptedOptions = { status: 202 };
    const acceptedRegistration = new Response(acceptedBody, acceptedOptions);
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(rejectedCapture(400));
    fetch.mockResolvedValueOnce(acceptedRegistration);
    const fixture = TestBed.createComponent(McpInstall);
    fixture.detectChanges();
    const element = rootOf(fixture);
    const input = element.querySelector<HTMLInputElement>('#remote-url');
    const form = element.querySelector('form');
    if (!input || !form) throw new Error('Missing source form');
    input.value = 'https://private.example/mcp';
    input.dispatchEvent(new Event('input'));
    const submissionOptions = { cancelable: true };
    const refusedSubmission = new Event('submit', submissionOptions);
    form.dispatchEvent(refusedSubmission);
    await fixture.whenStable();
    expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('refused');

    input.value = 'https://corrected.example/mcp';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(input.value).toBe('https://corrected.example/mcp');
    expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('draft');
    expect(element.textContent).not.toContain('This address was refused');
    const discover = element.querySelector<HTMLButtonElement>('button[type=submit]');
    if (!discover) throw new Error('Missing Continue button');
    expect(discover.textContent).toContain('Continue');
    if (submission === 'button') {
      discover.click();
    } else {
      // jsdom does not submit a form on Enter, so send the submit event directly.
      const correctedSubmission = new Event('submit', submissionOptions);
      form.dispatchEvent(correctedSubmission);
    }
    await fixture.whenStable();

    const correctedSource = { locator: 'https://corrected.example/mcp' };
    const correctedBody = JSON.stringify(correctedSource);
    const correctedRequest = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: correctedBody,
    };
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith('/api/org/integrations', correctedRequest);
    expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('checking');
    expect(element.textContent).toContain('Validating the server and discovering tools');
    expect(element.textContent).toContain('corrected-change');
  },
);

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
  // Add the dialog methods jsdom lacks before the loader runs after rendering.
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

it('keeps an unconfirmed registration explicit after reload', () => {
  sessionStorage.setItem('mcp-registration', 'https://mcp.example/mcp');
  const fixture = TestBed.createComponent(McpInstall);
  fixture.detectChanges();
  const element = rootOf(fixture);
  expect(element.querySelector('[data-state]')?.getAttribute('data-state')).toBe('unknown');
  expect(element.querySelector('.message')?.textContent).toContain('Outcome unknown');
  expect(element.textContent).toContain('Check status to restore your change');
});
