import { z } from 'zod';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderChat } from './provider-chat';
import { findButton, fixtureElement, requiredButton } from './models-testing';

const provider = { providerId: 'primary', provider: 'openai' as const, name: 'Primary',
  revision: 2, position: 7, enabledModels: ['gpt-6.1-sol'], status: 'ready' };

async function switchesOnThroughCheckedCommands(historyChanges: boolean) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let bindingReads = 0;
  let draining = false;
  let enabled = false;
  function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    return Promise.resolve(requestReply(input, options));
  }
  function requestReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = requestPath(input);
    const body = typeof options?.body === 'string' ?
      z.record(z.string(), z.unknown()).parse(JSON.parse(options.body)) : undefined;
    if (body) {
      requests.push({ path, body });
      if (path.endsWith('/drain')) {
        draining = true;
      }
      if (path.endsWith('/switch-on')) {
        enabled = true;
      }
      const receipt = { status: 'appended', revision: 2, sequence: 8 };
      return new Response(JSON.stringify(receipt));
    }
    if (path.endsWith('/bindings')) {
      bindingReads++;
      if (historyChanges && bindingReads === 1) {
        return new Response('{"status":"unavailable"}', { status: 503 });
      }
      const position = historyChanges ? 8 : 6;
      const chatDefault = historyChanges ? { position, sourceRevision: 4 } : { position };
      const bindings = { expectedProviderSequence: position + 1, chatDefault };
      return new Response(JSON.stringify(bindings));
    }
    const status = { revision: 2, sequence: 8,
      expectedProviderSequence: 7, draining, enabled };
    return new Response(JSON.stringify(status));
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.selectDefault();
  expect(bindingReads).toBe(historyChanges ? 2 : 1);
  expect(requests[0]?.body).toMatchObject({ action: 'select_chat_default',
    model: 'gpt-6.1-sol', expectedRevision: 2,
    expectedProviderSequence: historyChanges ? 9 : 7,
    expectedBindingSequence: historyChanges ? 8 : 6 });
  expect(requests[0]?.body['expectedSourceRevision']).toBe(historyChanges ? 4 : undefined);
  await fixture.componentInstance.startDrain();
  expect(requests[1]?.body).toMatchObject({ action: 'start', expectedRevision: 2,
    expectedProviderSequence: 7, expectedDrainSequence: 8 });
  await fixture.componentInstance.switchOn();
  expect(requests[2]?.path).toBe('/api/org/providers/primary/switch-on');
  expect(requests).toHaveLength(3);
  fixture.detectChanges();
  const element = fixtureElement(fixture);
  expect(element.textContent).toContain('Member chats switched on');
}

it('selects the default then drains and switches on through the guarded provider routes',
  switchesOnThroughCheckedCommands.bind(null, false));
it('reads fresh binding positions after history changes during the first read',
  switchesOnThroughCheckedCommands.bind(null, true));
afterEach(cleanup);
function cleanup() { vi.unstubAllGlobals(); TestBed.resetTestingModule(); }

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function holdsUnknownCommand() {
  let writes = 0;
  let recorded = false;
  function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = requestPath(input);
    if (options?.method === 'POST') {
      writes++;
      return Promise.resolve(new Response('{}', { status: 503 }));
    }
    if (path.includes('/changes/')) {
      const body = recorded ? { status: 'appended', revision: 2, sequence: 8 } : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: recorded ? 200 : 404 }));
    }
    const status = { revision: 2, sequence: 7, expectedProviderSequence: 7,
      draining: false, enabled: false };
    return Promise.resolve(new Response(JSON.stringify(status)));
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.startDrain();
  await fixture.componentInstance.startDrain();
  await fixture.componentInstance.checkStatus();
  await fixture.componentInstance.startDrain();
  expect(writes).toBe(1);
  recorded = true;
  await fixture.componentInstance.checkStatus();
  await fixture.componentInstance.startDrain();
  expect(writes).toBe(2);
}
it('holds an unknown write until its original receipt can be read', holdsUnknownCommand);

async function refusesWithoutCurrentAccess() {
  let writes = 0;
  function refusedReply(_input: RequestInfo | URL, options?: RequestInit) {
    if (options?.method === 'POST') writes++;
    return Promise.resolve(new Response('{}', { status: 403 }));
  }
  vi.stubGlobal('fetch', refusedReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.startDrain();
  await fixture.componentInstance.switchOn();
  expect(writes).toBe(0);
}
it('sends no drain or switch-on command when current status refuses access',
  refusesWithoutCurrentAccess);

async function defaultCannotBeRead(statuses: number[], message: string): Promise<void> {
  const reads: string[] = [];
  const writes: string[] = [];
  function unavailableReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = requestPath(input);
    if (options?.method === 'POST') {
      writes.push(path);
      throw new Error('No change should be sent without current binding positions');
    }
    const status = statuses[reads.length] ?? 500;
    reads.push(path);
    return Promise.resolve(new Response('{"status":"unavailable"}', { status }));
  }
  vi.stubGlobal('fetch', unavailableReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.selectDefault();
  fixture.detectChanges();
  const element = fixtureElement(fixture);
  expect(element.querySelector('[role=status]')?.textContent).toContain(message);
  expect(reads).toEqual(Array<string>(statuses.length).fill('/api/org/providers/primary/bindings'));
  expect(writes).toEqual([]);
}

const unavailableDefault = 'Could not read the chat default. Select chat default again.';
const refusedDefault = 'You no longer have access to read the chat default. Refresh Settings.';
it('reports a second unavailable bindings read without sending a change',
  defaultCannotBeRead.bind(null, [503, 503], unavailableDefault));
it('honours access loss during the fresh bindings read without sending a change',
  defaultCannotBeRead.bind(null, [503, 403], refusedDefault));
it('honours an access refusal on the first bindings read',
  defaultCannotBeRead.bind(null, [403], refusedDefault));
it('does not repeat a bindings read after any other server error',
  defaultCannotBeRead.bind(null, [500], unavailableDefault));

async function explainsMissingModelAnswer(): Promise<void> {
  const fetchReply = vi.fn();
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  const untested = { ...provider, status: 'connected_not_tested' };
  fixture.componentRef.setInput('provider', untested);
  fixture.detectChanges();
  const element = fixtureElement(fixture);
  const select = requiredButton(element, 'Select chat default');
  expect(select.disabled).toBe(true);
  expect(element.textContent).toContain('Open this connection and run the priced test');
  expect(findButton(element, 'Pause new calls')).toBeUndefined();
  await fixture.componentInstance.selectDefault();
  await fixture.componentInstance.startDrain();
  await fixture.componentInstance.switchOn();
  expect(fetchReply).not.toHaveBeenCalled();
}
it('shows how to finish verification before selecting a default', explainsMissingModelAnswer);

function drainReply(draining = false, enabled = false): Response {
  const status = { revision: 2, sequence: 8, expectedProviderSequence: 8, draining, enabled };
  return new Response(JSON.stringify(status));
}

async function hidesPauseAfterStatusRead() {
  function fetchReply(input: RequestInfo | URL) {
    const path = requestPath(input);
    expect(path).toBe('/api/org/providers/primary/drain');
    return Promise.resolve(drainReply());
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  const untested = { ...provider, status: 'connected_not_tested' };
  fixture.componentRef.setInput('provider', untested);
  fixture.detectChanges();
  await fixture.componentInstance.checkStatus();
  fixture.detectChanges();
  const element = fixtureElement(fixture);
  expect(findButton(element, 'Pause new calls')).toBeUndefined();
}
it('hides Pause new calls for an unready connection after checking chat setup',
  hidesPauseAfterStatusRead);

function bindingPositions(): Response {
  const status = { expectedProviderSequence: 7, chatDefault: null };
  return new Response(JSON.stringify(status));
}

function savedChoice(): Response {
  const receipt = { status: 'appended', revision: 2, sequence: 8 };
  return new Response(JSON.stringify(receipt));
}

async function recoversChatDefault(definite: boolean) {
  const commands: string[] = [];
  const statusReads: string[] = [];
  let recorded = false;
  const command = z.object({ commandId: z.string() });
  function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = requestPath(input);
    if (options?.method === 'POST') {
      const text = z.string().parse(options.body);
      const body = command.parse(JSON.parse(text));
      commands.push(body.commandId);
      if (commands.length > 1) {
        return Promise.resolve(savedChoice());
      }
      if (definite) {
        const response = new Response('{"status":"access_applying"}', { status: 425 });
        return Promise.resolve(response);
      }
      return Promise.reject(new TypeError('Connection lost after sending the request'));
    }
    if (path.includes('/changes/')) {
      statusReads.push(path);
      const response = recorded ? savedChoice() : new Response('{}', { status: 404 });
      return Promise.resolve(response);
    }
    const response = path.endsWith('/bindings') ? bindingPositions() : drainReply();
    return Promise.resolve(response);
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  const chat = fixture.componentInstance;
  const element = fixtureElement(fixture);
  await chat.selectDefault();
  fixture.detectChanges();
  if (definite) {
    expect(element.textContent).toContain('Your access is still being updated');
    expect(requiredButton(element, 'Select chat default').disabled).toBe(false);
    await chat.checkStatus();
    expect(statusReads).toHaveLength(0);
  } else {
    expect(element.textContent).toContain('Outcome unknown.');
    expect(requiredButton(element, 'Select chat default').disabled).toBe(true);
    await chat.checkStatus();
    await chat.selectDefault();
    expect(commands).toHaveLength(1);
    const original = '/api/org/providers/primary/changes/' + commands[0];
    expect(statusReads).toEqual([original]);
    recorded = true;
    await chat.checkStatus();
    expect(statusReads).toEqual([original, original]);
  }
  await chat.selectDefault();
  expect(commands).toHaveLength(2);
  expect(commands[0]).not.toEqual(commands[1]);
  fixture.detectChanges();
  expect(element.textContent).toContain('Chat default saved.');
}
it('unlocks a definite 425 without looking for a receipt', recoversChatDefault.bind(null, true));
it('checks the original receipt after a lost default reply', recoversChatDefault.bind(null, false));

async function explainsDefaultRefusal(reason: string, message: string) {
  function fetchReply(_input: RequestInfo | URL, options?: RequestInit) {
    const refusal = { status: 'refused', reason };
    const response = options?.method === 'POST'
      ? new Response(JSON.stringify(refusal), { status: 403 })
      : bindingPositions();
    return Promise.resolve(response);
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.selectDefault();
  fixture.detectChanges();
  expect(fixtureElement(fixture).textContent).toContain(message);
}
const refusals = [
  ['permission_denied', 'You need permission to manage the connections for this choice.'],
  ['connection_not_ready', 'This connection is not ready for member chats.'],
  ['model_not_enabled', 'Choose a supported model enabled on this connection.'],
];
it.each(refusals)('explains the chat default refusal %s', explainsDefaultRefusal);

async function readyActions(draining: boolean, enabled: boolean) {
  let choices = 0;
  function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = requestPath(input);
    if (options?.method === 'POST') {
      expect(path).toMatch(/\/backup\/bindings$/);
      choices++;
      return Promise.resolve(savedChoice());
    }
    const response = path.endsWith('/bindings') ? bindingPositions() : drainReply(draining, enabled);
    return Promise.resolve(response);
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  const backup = { ...provider, providerId: 'backup', name: 'Backup' };
  fixture.componentRef.setInput('provider', backup);
  fixture.detectChanges();
  const element = fixtureElement(fixture);
  expect(findButton(element, 'Pause new calls')).toBeUndefined();
  await fixture.componentInstance.checkStatus();
  fixture.detectChanges();
  expect(requiredButton(element, 'Select chat default').disabled).toBe(false);
  if (enabled) {
    expect(findButton(element, 'Pause new calls')).toBeUndefined();
    expect(findButton(element, 'Switch on member chats')).toBeUndefined();
  } else {
    expect(requiredButton(element, 'Pause new calls').disabled).toBe(draining);
    expect(requiredButton(element, 'Switch on member chats').disabled).toBe(!draining);
  }
  await fixture.componentInstance.selectDefault();
  expect(choices).toBe(1);
}
const setupStages = [[false, false], [true, false], [false, true]] as const;
it.each(setupStages)('offers ready actions when draining: %s, enabled: %s', readyActions);
