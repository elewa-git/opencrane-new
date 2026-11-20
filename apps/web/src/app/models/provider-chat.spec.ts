import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderChat } from './provider-chat';

const provider = { providerId: 'primary', provider: 'openai' as const, name: 'Primary',
  revision: 2, position: 7, enabledModels: ['gpt-6.1-sol'], status: 'tested' };

async function switchesOnThroughCheckedCommands() {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let draining = false;
  let enabled = false;
  async function fetchReply(input: RequestInfo | URL, options?: RequestInit) {
    const path = String(input);
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
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
  expect((fixture.nativeElement as HTMLElement).textContent).toContain('Member chats switched on');
}

it('selects the default then drains and switches on through the guarded provider routes',
  switchesOnThroughCheckedCommands);
afterEach(cleanup);
function cleanup() { vi.unstubAllGlobals(); TestBed.resetTestingModule(); }
