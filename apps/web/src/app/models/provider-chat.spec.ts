import { z } from 'zod';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderChat } from './provider-chat';

const provider = { providerId: 'primary', provider: 'openai' as const, name: 'Primary',
  revision: 2, position: 7, enabledModels: ['gpt-6.1-sol'], status: 'tested' };

async function switchesOnThroughCheckedCommands() {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
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
      if (path.endsWith('/drain')) draining = true;
      if (path.endsWith('/switch-on')) enabled = true;
      return new Response(JSON.stringify({ status: 'appended', revision: 2, sequence: 8 }));
    }
    if (path.endsWith('/bindings')) {
      return new Response(JSON.stringify({ expectedProviderSequence: 7,
        rows: [{ kind: 'silo_default', dependantId: 'dev', position: 6 }] }));
    }
    return new Response(JSON.stringify({ revision: 2, sequence: 8,
      expectedProviderSequence: 7, draining, enabled }));
  }
  vi.stubGlobal('fetch', fetchReply);
  const fixture = TestBed.createComponent(ProviderChat);
  fixture.componentRef.setInput('provider', provider);
  fixture.detectChanges();
  await fixture.componentInstance.selectDefault();
  expect(requests[0]?.body).toMatchObject({ action: 'select', kind: 'silo_default',
    dependantId: 'dev', model: 'gpt-6.1-sol', expectedBindingSequence: 6 });
  await fixture.componentInstance.startDrain();
  expect(requests[1]?.body).toMatchObject({ action: 'start', expectedRevision: 2,
    expectedProviderSequence: 7, expectedDrainSequence: 8 });
  await fixture.componentInstance.switchOn();
  expect(requests[2]?.path).toBe('/api/org/providers/primary/switch-on');
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  expect(element).toBeInstanceOf(HTMLElement);
  if (!(element instanceof HTMLElement)) throw new Error('Expected a chat setup element');
  expect(element.textContent).toContain('Member chats switched on');
}

it('selects the default then drains and switches on through the guarded provider routes',
  switchesOnThroughCheckedCommands);
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
