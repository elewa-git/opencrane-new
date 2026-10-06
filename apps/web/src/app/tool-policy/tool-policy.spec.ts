import { TestBed } from '@angular/core/testing';
import { ToolPolicyScreen } from './tool-policy';

type Mode = 'allow' | 'ask' | 'block';

function makePolicy(overrides: Record<string, unknown> = {}) {
  return {
    sequence: 12,
    connectionId: 'validation-connection',
    accountMode: 'none',
    published: false,
    tools: [
      { name: 'read_item', revision: 'revision-1', reviewed: true, readOnly: true,
        mode: 'block' as Mode, suggestion: 'allow' },
      { name: 'write_item', revision: 'revision-2', reviewed: true, readOnly: false,
        mode: 'block' as Mode, suggestion: 'ask' },
    ],
    ...overrides,
  };
}

function reply(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function isRequestCall(value: unknown): value is [RequestInfo | URL, RequestInit | undefined] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const options: unknown = value[1];
  if (options === undefined) return true;
  return typeof options === 'object' && options !== null && 'body' in options;
}

function requestBody(call: unknown): Record<string, unknown> {
  if (!isRequestCall(call)) throw new Error('Expected a tool policy request');
  const options = call[1];
  if (!options || typeof options.body !== 'string') {
    throw new Error('Expected a JSON request body');
  }
  const body: unknown = JSON.parse(options.body);
  if (!isRecord(body)) {
    throw new Error('Expected a request object');
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function screenRoot(fixture: ReturnType<typeof TestBed.createComponent>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected tool screen');
  return root;
}

function buttonNamed(root: HTMLElement, name: string): HTMLButtonElement {
  const buttons = root.querySelectorAll<HTMLButtonElement>('button');
  for (const button of buttons) {
    const label = button.getAttribute('aria-label');
    const text = button.textContent?.trim();
    if (label === name || text === name) return button;
  }
  throw new Error(`Expected button named ${name}`);
}

function selectMode(root: HTMLElement, toolName: string, mode: Mode): void {
  const radio = root.querySelector<HTMLInputElement>(
    `input[name="mode-${toolName}"][value="${mode}"]`,
  );
  if (!radio) throw new Error(`Expected ${mode} radio for ${toolName}`);
  radio.click();
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForTools(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(root.querySelectorAll('fieldset')).toHaveLength(2));
}

afterEach(() => vi.restoreAllMocks());

it('uses native mode radios, shows a live summary and disables saves without changes', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  expect(root.textContent).toContain('2 tools');
  expect(root.textContent).toContain('Reads data');
  expect(root.textContent).toContain('May change data');
  expect(root.textContent).toContain('Nobody can use these tools yet');
  expect(root.querySelector('input[name="mode-read_item"][value="allow"]')).not.toBeNull();
  expect(buttonNamed(root, 'Save mode for read_item').disabled).toBe(true);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  expect(root.textContent).toContain('1 Allow automatically · 0 Ask · 1 Block');
  expect(buttonNamed(root, 'Save mode for read_item').disabled).toBe(false);
  selectMode(root, 'read_item', 'block');
  fixture.detectChanges();
  expect(root.querySelector('.unsaved-choice')).toBeNull();
  expect(buttonNamed(root, 'Save mode for read_item').disabled).toBe(true);
  expect(root.textContent).toContain('Audience');
  expect(root.textContent).toContain('Not available yet');
  fixture.destroy();
});

it('holds saves while pending, keeps an uncertain change read-only and clears access loss', async () => {
  let finishSave!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }))
    .mockResolvedValueOnce(reply(403));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saving read_item'));
  expect(root.querySelector('fieldset')?.disabled).toBe(true);
  finishSave(reply(503));
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  expect(root.querySelector('.tools-card')?.getAttribute('aria-busy')).toBe('false');
  expect(root.querySelector('fieldset')?.disabled).toBe(true);
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  expect(root.querySelector('h1')?.textContent).toContain('Integrations');
  expect(root.querySelector('fieldset')).toBeNull();
  expect(fetch.mock.calls.map(requestMethod)).toEqual(['GET', 'POST', 'GET']);
  fixture.destroy();
});

it('gives people without admin access no enabled save or protected tool details', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(403));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.textContent).toContain('You no longer have access'));
  expect(root.querySelector('input, button')).toBeNull();
  expect(root.textContent).not.toContain('read_item');
  fixture.destroy();
});

it('shows a neutral conflict and keeps only choices for unchanged reviewed tools', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(409, { status: 'conflict' }))
    .mockResolvedValueOnce(reply(200, makePolicy({
      sequence: 13,
      tools: [
        { name: 'read_item', revision: 'revision-1', reviewed: true, readOnly: true,
          mode: 'block', suggestion: 'allow' },
        { name: 'write_item', revision: 'revision-3', reviewed: true, readOnly: false,
          mode: 'block', suggestion: 'ask' },
      ],
    })));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  selectMode(root, 'write_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('The tools changed before your save'));
  expect(buttonNamed(root, 'Review the current modes')).toBeDefined();
  expect(buttonNamed(root, 'Discard my edits')).toBeDefined();
  expect(root.textContent).not.toContain('Someone');
  buttonNamed(root, 'Review the current modes').click();
  await vi.waitFor(() => expect(root.querySelectorAll('.unsaved-choice')).toHaveLength(1));
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-read_item"][value="allow"]',
  )?.checked).toBe(true);
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-write_item"][value="ask"]',
  )?.checked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
  fixture.destroy();
});

it('discards choices with a GET after the conflict', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(409))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('The tools changed before your save'));
  buttonNamed(root, 'Discard my edits').click();
  await vi.waitFor(() => expect(root.querySelector('.unsaved-choice')).toBeNull());
  expect(fetch.mock.calls[2]?.[1]?.method).toBe('GET');
  fixture.destroy();
});

it('keeps a lost save unknown, disables every fieldset and never posts while checking', async () => {
  const commandId = '00000000-0000-4000-8000-000000000004';
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy({ sequence: 13,
      tools: [{ ...makePolicy().tools[0], mode: 'ask' }] })));
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(commandId);
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  expect(changeReference(root)).toBe(commandId);
  expect([...root.querySelectorAll('fieldset')].every(isDisabled)).toBe(true);
  expect(buttonNamed(root, 'Check status')).toBeDefined();
  expect(root.querySelectorAll('.state-action')).toHaveLength(1);
  expect([...root.querySelectorAll('button')].some((button) =>
    button.textContent?.trim() === 'Reload tools')).toBe(false);
  expect(root.querySelector('button')?.textContent).not.toContain('Try again');
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved policy matches your change'));
  expect(changeReference(root)).toBe(commandId);
  expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
  expect(fetch.mock.calls[2]?.[1]?.method).toBe('GET');
  fixture.destroy();
});

it('offers Reload tools when a status read leaves the result unknown', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  buttonNamed(root, 'Reload tools').click();
  await vi.waitFor(() => expect(root.textContent).toContain(
    'Your earlier change may still appear. Check the modes before saving again.',
  ));
  await vi.waitFor(() => expect(root.querySelector('fieldset')?.disabled).toBe(false));
  const methods = fetch.mock.calls.map(requestMethod);
  expect(methods).toEqual(['GET', 'POST', 'GET', 'GET', 'GET']);
  expect(methods.filter(isPost)).toHaveLength(1);
  fixture.destroy();
});

it('shows the conflict notice when a changed saved mode no longer matches', async () => {
  const commandId = '00000000-0000-4000-8000-000000000005';
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy({ sequence: 13,
      tools: [{ ...makePolicy().tools[0], mode: 'block' }] })));
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(commandId);
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain(
    'The saved modes don’t match your change',
  ));
  expect(root.textContent).toContain('The tools changed after your save. We can’t tell whether');
  expect(changeReference(root)).toBe(commandId);
  fixture.destroy();
});

it('reports invalid saves without offering Try again', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(400, { status: 'invalid_request' }))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Failed — nothing changed'));
  expect(root.textContent).not.toContain('Try again');
  expect(root.textContent).not.toContain('Change reference:');
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-read_item"][value="block"]',
  )?.checked).toBe(true);
  expect(buttonNamed(root, 'Reload tools')).toBeDefined();
  fixture.destroy();
});

it('describes the disabled tool controls when there is no validation connection', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200,
    makePolicy({ connectionId: null })));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  expect(root.textContent).toContain(
    "Modes can't be saved yet: this server has no validation connection.",
  );
  const fieldset = root.querySelector('fieldset');
  expect(fieldset?.disabled).toBe(true);
  expect(fieldset?.getAttribute('aria-describedby')).toBe('connection-note');
  fixture.destroy();
});

it('explains a tools record that is not ready yet and lets the admin check again', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(400))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.textContent).toContain(
    'Not ready yet: discovery is still being recorded.',
  ));
  buttonNamed(root, 'Reload tools').click();
  await waitForTools(root);
  expect(fetch.mock.calls.map(requestMethod)).toEqual(['GET', 'GET']);
  fixture.destroy();
});

it('disables and describes unreviewed tools', async () => {
  const unreviewed = makePolicy({
    tools: [{ name: 'unreviewed_tool', revision: 'revision-1', reviewed: false,
      readOnly: false, mode: 'block', suggestion: 'ask' }],
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, unreviewed));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.querySelector('fieldset')).not.toBeNull());
  const radio = root.querySelector<HTMLInputElement>('input[name="mode-unreviewed_tool"]');
  expect(root.querySelector('fieldset')?.disabled).toBe(true);
  expect(radio?.getAttribute('aria-describedby')).toBe('tool-unreviewed-unreviewed_tool');
  expect(root.textContent).toContain('Unreviewed — blocked until reviewed');
  fixture.destroy();
});

it('says a published policy still needs a current grant', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200,
    makePolicy({ published: true })));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  expect(root.textContent).toContain('Saved modes apply only to people and assistants');
  expect(root.textContent).toContain("Grants can't be read here yet.");
  fixture.destroy();
});

it('clears protected tools and focuses the access-lost heading after a refused save', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(403));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  const heading = root.querySelector('#integration-access-heading');
  expect(document.activeElement).toBe(heading);
  expect(root.querySelector('fieldset')).toBeNull();
  expect(root.querySelector('.editing-summary')).toBeNull();
  expect(root.querySelector('oc-add-flow-steps')).toBeNull();
  expect(root.querySelector('.audience')).toBeNull();
  fixture.destroy();
});

it('ignores a late save reply after the page is destroyed', async () => {
  let finishSave!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saving read_item'));

  const lateReply = reply(200, { status: 'appended', policy: makePolicy() });
  const readLateReply = vi.spyOn(lateReply, 'json');
  fixture.destroy();
  finishSave(lateReply);
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  await fixture.whenStable();
  expect(readLateReply).not.toHaveBeenCalled();
  expect(root.querySelector('h1')?.textContent).toContain('Tools & access');
  expect(root.textContent).toContain('Saving read_item…');
  expect(root.textContent).not.toContain('Saved read_item');
  expect(root.querySelector('fieldset')).not.toBeNull();
});

it('keeps a second tool disabled while the first save is pending', async () => {
  let finishSave!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saving read_item'));
  expect([...root.querySelectorAll('fieldset')].every(isDisabled)).toBe(true);
  expect([...root.querySelectorAll('button[aria-label^="Save mode"]')]
    .every(isButtonDisabled)).toBe(true);
  finishSave(reply(200, { status: 'appended', policy: makePolicy({ sequence: 13 }) }));
  fixture.destroy();
});

it('keeps other choices after a refused save and a tools reload', async () => {
  let finishReload!: (response: Response) => void;
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(400))
    .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  selectMode(root, 'write_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Failed — nothing changed'));
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-write_item"][value="ask"]',
  )?.checked).toBe(true);
  buttonNamed(root, 'Reload tools').click();
  await vi.waitFor(() => expect(root.querySelector('fieldset')?.disabled).toBe(true));
  finishReload(reply(200, makePolicy()));
  await vi.waitFor(() => expect([...root.querySelectorAll('fieldset')].every(isDisabled))
    .toBe(false));
  await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-write_item"][value="ask"]',
  )?.checked).toBe(true));
  expect(root.querySelector('.unsaved-choice')?.textContent).toContain('Your unsaved choice');
  expect(fetch.mock.calls.filter((call) => requestMethod(call) === 'POST')).toHaveLength(1);
  fixture.destroy();
});

it('keeps other choices after a lost reply, an unknown check and reload', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  selectMode(root, 'write_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  expect(root.querySelector('button:not(.state-action)')?.textContent).not.toContain('Reload tools');
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  buttonNamed(root, 'Reload tools').click();
  await vi.waitFor(() => expect(root.textContent).toContain(
    'Your earlier change may still appear. Check the modes before saving again.',
  ));
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-write_item"][value="ask"]',
  )?.checked).toBe(true);
  expect(root.textContent).toContain('Your unsaved choice');
  expect(fetch.mock.calls.filter((call) => requestMethod(call) === 'POST')).toHaveLength(1);
  fixture.destroy();
});

it('removes an unsaved marker when a status read shows the saved mode', async () => {
  const checkedPolicy = makePolicy({ tools: [
    makePolicy().tools[0],
    { ...makePolicy().tools[1], mode: 'ask' },
  ] });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, checkedPolicy));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  selectMode(root, 'write_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  const writeFieldset = [...root.querySelectorAll('fieldset')]
    .find((fieldset) => fieldset.querySelector('legend')?.textContent === 'write_item');
  expect(writeFieldset?.querySelector('.unsaved-choice')).toBeNull();
  expect(writeFieldset?.querySelector<HTMLInputElement>('input[value="ask"]')?.checked)
    .toBe(true);
  fixture.destroy();
});

it('keeps edits and offers both reads when a status check fails', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(503));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain(
    "Couldn't check. The change is still unknown.",
  ));
  expect(root.querySelectorAll('.state-action')).toHaveLength(1);
  expect(root.querySelectorAll('button').length).toBeGreaterThan(1);
  expect([...root.querySelectorAll('button')].some((button) =>
    button.textContent?.trim() === 'Reload tools')).toBe(true);
  expect(fetch.mock.calls.filter((call) => requestMethod(call) === 'POST')).toHaveLength(1);
  fixture.destroy();
});

it('saves twice with new command ids and the latest sequence', async () => {
  const firstPolicy = makePolicy({ sequence: 13,
    tools: [{ ...makePolicy().tools[0], mode: 'ask' }] });
  const secondPolicy = makePolicy({ sequence: 14,
    tools: [{ ...makePolicy().tools[0], mode: 'allow' }] });
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, { status: 'appended', policy: firstPolicy }))
    .mockResolvedValueOnce(reply(200, { status: 'appended', policy: secondPolicy }));
  const uuid = vi.spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved read_item: Ask'));
  expect(root.textContent).toContain('00000000-0000-4000-8000-000000000001');
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved read_item: Allow automatically'));
  const firstBody = requestBody(fetch.mock.calls[1]);
  const secondBody = requestBody(fetch.mock.calls[2]);
  expect(firstBody['commandId']).toBe('00000000-0000-4000-8000-000000000001');
  expect(secondBody['commandId']).toBe('00000000-0000-4000-8000-000000000002');
  expect(secondBody['expectedSequence']).toBe(13);
  expect(uuid).toHaveBeenCalledTimes(2);
  fixture.destroy();
});

it('clears the saved choice and keeps another tool choice after a confirmed save', async () => {
  const savedPolicy = makePolicy({ sequence: 13, tools: [
    { ...makePolicy().tools[0], mode: 'allow' },
    makePolicy().tools[1],
  ] });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, { status: 'appended', policy: savedPolicy }));
  vi.spyOn(crypto, 'randomUUID')
    .mockReturnValue('00000000-0000-4000-8000-000000000003');
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'allow');
  fixture.detectChanges();
  selectMode(root, 'write_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved read_item: Allow automatically'));
  expect(root.textContent).toContain('00000000-0000-4000-8000-000000000003');
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-read_item"][value="allow"]',
  )?.checked).toBe(true);
  expect(root.querySelector<HTMLInputElement>(
    'input[name="mode-write_item"][value="ask"]',
  )?.checked).toBe(true);
  expect(root.querySelectorAll('.unsaved-choice')).toHaveLength(1);
  fixture.destroy();
});

it('keeps focus on the status message when Review the current modes disappears', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(409))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('The tools changed before your save'));
  buttonNamed(root, 'Review the current modes').focus();
  buttonNamed(root, 'Review the current modes').click();
  await vi.waitFor(() => expect(root.querySelector('#tool-status')).not.toBeNull());
  await waitForFocusedElement(root, '#tool-status');
  fixture.destroy();
});

it('keeps focus on the status message when Discard my edits disappears', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(409))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('The tools changed before your save'));
  buttonNamed(root, 'Discard my edits').focus();
  buttonNamed(root, 'Discard my edits').click();
  await waitForFocusedElement(root, '#tool-status');
  fixture.destroy();
});

it('keeps focus on the status message when Reload tools disappears', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  buttonNamed(root, 'Reload tools').focus();
  buttonNamed(root, 'Reload tools').click();
  await waitForFocusedElement(root, '#tool-status');
  fixture.destroy();
});

it('moves focus to the status region while Check status is reading', async () => {
  let finishCheck!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').focus();
  buttonNamed(root, 'Check status').click();
  await waitForFocusedElement(root, '#tool-status');
  finishCheck(reply(200, makePolicy()));
  fixture.destroy();
});

it('reloads a healthy list without announcing a failure or losing current choices', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await vi.waitFor(() => expect(root.textContent).toContain("Couldn't load tools."));
  buttonNamed(root, 'Reload tools').click();
  await waitForTools(root);
  expect(root.textContent).not.toContain("Couldn't load tools.");
  expect(root.textContent).not.toContain("Couldn't check.");
  expect(fetch.mock.calls.map(requestMethod)).toEqual(['GET', 'GET']);
  fixture.destroy();
});

it('focuses Check status after a check still cannot confirm the save', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy()));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Still unknown'));
  await waitForFocusedElement(root, '.state-action');
  fixture.destroy();
});

it('focuses the saved status after a successful save', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(200, {
      status: 'appended', policy: makePolicy({ sequence: 13 }),
    }));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved read_item: Ask'));
  await waitForFocusedElement(root, '#tool-status');
  fixture.destroy();
});

async function waitForFocusedElement(root: HTMLElement, selector: string): Promise<void> {
  await vi.waitFor(() => {
    const target = root.querySelector(selector);
    expect(document.activeElement).toBe(target);
    expect(document.activeElement).not.toBe(document.body);
  });
}

function changeReference(root: HTMLElement): string | undefined {
  const reference = root.querySelector('.detail code');
  return reference?.textContent?.trim();
}

function isDisabled(fieldset: HTMLFieldSetElement): boolean {
  return fieldset.disabled;
}

function isButtonDisabled(element: Element): boolean {
  if (!(element instanceof HTMLButtonElement)) return false;
  return element.disabled;
}

function requestMethod(call: Parameters<typeof fetch>): string {
  const options = call[1];
  return options?.method ?? 'GET';
}

function isPost(method: string): boolean {
  return method === 'POST';
}
