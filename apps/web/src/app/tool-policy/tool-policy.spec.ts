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
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy({ sequence: 13,
      tools: [{ ...makePolicy().tools[0], mode: 'ask' }] })));
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root = screenRoot(fixture);
  await waitForTools(root);
  selectMode(root, 'read_item', 'ask');
  fixture.detectChanges();
  buttonNamed(root, 'Save mode for read_item').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Outcome unknown'));
  expect([...root.querySelectorAll('fieldset')].every(isDisabled)).toBe(true);
  expect(buttonNamed(root, 'Check status')).toBeDefined();
  expect(root.querySelectorAll('.state-action')).toHaveLength(1);
  expect(root.querySelector('button')?.textContent).not.toContain('Try again');
  buttonNamed(root, 'Check status').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Saved policy matches your change'));
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
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(reply(200, makePolicy()))
    .mockResolvedValueOnce(reply(503))
    .mockResolvedValueOnce(reply(200, makePolicy({ sequence: 13,
      tools: [{ ...makePolicy().tools[0], mode: 'block' }] })));
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
  await vi.waitFor(() => expect(root.textContent).toContain('The tools changed before your save'));
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
  expect(buttonNamed(root, 'Reload tools')).toBeDefined();
  fixture.destroy();
});

it('disables saves when there is no validation connection', async () => {
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
  expect(buttonNamed(root, 'Save mode for read_item').disabled).toBe(true);
  const fieldset = root.querySelector('fieldset');
  expect(fieldset?.disabled).toBe(true);
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

it('ignores a late save reply after access has been refused', async () => {
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

  expect(fixture.componentInstance.clearOnAccessLoss(reply(403))).toBe(true);
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  finishSave(reply(200, { status: 'appended', policy: makePolicy() }));
  await vi.waitFor(() => expect(root.querySelector('#integration-access-heading')).not.toBeNull());
  expect(root.textContent).not.toContain('Saved read_item');
  fixture.destroy();
});

function isDisabled(fieldset: HTMLFieldSetElement): boolean {
  return fieldset.disabled;
}

function requestMethod(call: Parameters<typeof fetch>): string {
  const options = call[1];
  return options?.method ?? 'GET';
}

function isPost(method: string): boolean {
  return method === 'POST';
}
