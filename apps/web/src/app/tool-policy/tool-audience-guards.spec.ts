import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ToolAudience } from './tool-audience';

const checkedAt = '2026-10-22T10:00:00.000Z';
const reference = { commandId: 'original-command', action: 'grant' };
const storageKey = 'tool-audience:fixture';

function grant(granteeKind: 'member' | 'assistant', granteeId: string, displayName: string) {
  return { granteeKind, granteeId, displayName, source: 'direct', state: 'granted',
    eventId: `grant-${granteeId}`, eventTime: checkedAt, sequence: 4,
    projection: 'current', iam: 'current', membershipStatus: null };
}

function access(expectedSequence = 5) {
  const grants = [grant('member', 'alex', 'Alex'), grant('member', 'bea', 'Bea'),
    grant('assistant', 'bea-helper', 'Bea’s personal assistant')];
  return { serverId: 'fixture', expectedSequence, loadedAt: checkedAt, canManage: true,
    grants, complete: true, grantTotal: grants.length,
    projection: { content: 'current', iam: 'current', sequence: expectedSequence } };
}

function receipt() {
  return { status: 'appended', serverId: 'fixture', commandId: reference.commandId,
    operation: 'grant.given', sequence: 5, currentSequence: 5, changeId: 'change-one',
    projection: { content: 'current', iam: 'current' } };
}

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function mount() {
  const fixture = TestBed.createComponent(ToolAudience);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.componentRef.setInput('toolName', 'read_item');
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<ToolAudience>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected audience editor');
  return element;
}

function button(element: HTMLElement, label: string) {
  for (const candidate of element.querySelectorAll('button')) {
    if (candidate.textContent?.trim() === label) return candidate;
  }
  throw new Error(`Missing button: ${label}`);
}

async function settled(fixture: ComponentFixture<ToolAudience>) {
  function readsFinished() {
    if (fixture.componentInstance['state']() === 'access_changed') {
      fixture.detectChanges();
      return;
    }
    expect(fixture.componentInstance['busy']()).toBe(false);
    expect(fixture.componentInstance['picking']()).toBe(false);
    fixture.detectChanges();
  }
  await vi.waitFor(readsFinished);
}

afterEach(function cleanUp() {
  TestBed.resetTestingModule();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it.each(['schema', 'server', 'id', 'operation'])(
  'rejects a receipt with a mismatched %s and keeps its original status check',
  async function rejectsReceipt(mismatch) {
    const changed = receipt();
    if (mismatch === 'schema') changed.sequence = 0;
    if (mismatch === 'server') changed.serverId = 'another-server';
    if (mismatch === 'id') changed.commandId = 'another-command';
    if (mismatch === 'operation') changed.operation = 'grant.revoked';
    function read(input: RequestInfo | URL) {
      if (String(input).includes('/changes/')) return response(changed);
      return response(access());
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(read);
    sessionStorage.setItem(storageKey, JSON.stringify(reference));
    const fixture = mount();
    await settled(fixture);
    const element = root(fixture);
    expect(element.textContent).toContain('Outcome unknown');
    expect(element.textContent).not.toContain('Saved.');
    expect(button(element, 'Check status').disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(reference);
  },
);

it('rejects an access list older than the confirmed receipt', async function rejectsOldList() {
  function read(input: RequestInfo | URL) {
    if (String(input).includes('/changes/')) return response(receipt());
    return response(access(4));
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  sessionStorage.setItem(storageKey, JSON.stringify(reference));
  const fixture = mount();
  await settled(fixture);
  const element = root(fixture);
  expect(element.textContent).toContain('Access is still updating');
  expect(element.textContent).not.toContain('Saved.');
  expect(button(element, 'Check status').disabled).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(reference);
});

it.each([401, 403])('purges protected audience and candidate rows after %s',
  async function purgesRows(status) {
    let candidateReads = 0;
    function read(input: RequestInfo | URL) {
      if (String(input).includes('/candidates')) {
        candidateReads += 1;
        if (candidateReads > 1) return response({}, status);
        return response({ rows: [{ id: 'colleague', displayName: 'Private colleague' }],
          next: 'colleague', loadedAt: checkedAt,
          projection: { content: 'current', sequence: 5 } });
      }
      return response(access());
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(read);
    const fixture = mount();
    await settled(fixture);
    const element = root(fixture);
    button(element, 'Person').click();
    await settled(fixture);
    expect(element.textContent).toContain('Private colleague');
    expect(element.textContent).toContain('Bea’s personal assistant');
    button(element, 'Load more').click();
    await settled(fixture);
    expect(element.textContent).toContain('Details cleared');
    expect(element.textContent).not.toContain('Private colleague');
    expect(element.textContent).not.toContain('Bea’s personal assistant');
    expect(element.textContent).not.toContain('Alex');
  },
);

it('requires an explicit person and offers only that person’s assistants',
  async function selectsValidPair() {
    function read(input: RequestInfo | URL) {
      const path = String(input);
      if (path.startsWith('/api/members/')) {
        let assistants: { assistantId: string; grant: string }[] = [];
        if (path.includes('/bea/')) {
          assistants = [{ assistantId: 'bea-helper', grant: 'allowed' }];
        }
        return response({ checkedAt, complete: false, unavailableSections: ['use_availability'],
          rows: [{ resourceType: 'mcp_server', resourceId: 'fixture', relation: 'use', sources: [],
            eligibility: { person: 'allowed', assistants, availability: 'unavailable' } }] });
      }
      return response(access());
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(read);
    const fixture = mount();
    await settled(fixture);
    const element = root(fixture);
    expect(element.querySelector('a')).toBeNull();
    const person = element.querySelector<HTMLSelectElement>('select[aria-label="Person to explain"]');
    expect(person).not.toBeNull();
    person!.value = 'alex';
    person!.dispatchEvent(new Event('change'));
    await settled(fixture);
    expect(element.querySelector('a')).toBeNull();
    expect(element.textContent).toContain('No assistants are available for this person.');
    person!.value = 'bea';
    person!.dispatchEvent(new Event('change'));
    await settled(fixture);
    const assistant = element.querySelector<HTMLSelectElement>(
      'select[aria-label="Assistant to explain"]');
    expect(assistant?.textContent).toContain('Bea’s personal assistant');
    expect(element.querySelector('a')).toBeNull();
    assistant!.value = 'bea-helper';
    assistant!.dispatchEvent(new Event('change'));
    await settled(fixture);
    const link = element.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/org/integrations/fixture/access/explanation?'
      + 'requester=bea&assistant=bea-helper&tool=read_item');
    person!.value = 'alex';
    person!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelector('a')).toBeNull();
    await settled(fixture);
    expect(element.querySelector('a')).toBeNull();
  },
);
