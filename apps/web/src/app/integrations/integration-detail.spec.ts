import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { IntegrationRow, IntegrationsResponse, ToolPolicy } from '@opencrane/protocol';
import type { MockInstance } from 'vitest';
import { IntegrationDetail } from './integration-detail';

const loadedAt = '2026-10-05T09:14:00.000Z';

function row(
  kind: IntegrationRow['status']['kind'],
  detail: string,
): IntegrationRow {
  return {
    serverId: 'fixture-server', name: 'Fixture server',
    source: { kind: 'remote_url', label: 'Remote URL', detail: 'tools.example.test' },
    version: 'Version not provided', accountModel: 'Not provided',
    toolsAllowed: 0, toolsTotal: 2,
    status: { kind, label: statusLabel(kind), detail },
  };
}

function statusLabel(kind: IntegrationRow['status']['kind']): string {
  if (kind === 'ready') return 'Ready';
  if (kind === 'disabled') return 'Disabled';
  if (kind === 'needs_input') return 'Needs input';
  return 'Failed';
}

function listResponse(integration: IntegrationRow): IntegrationsResponse {
  return { rows: [integration], loadedAt };
}

function policy(published: boolean): ToolPolicy {
  return {
    silo: null, serverId: null, connectionId: 'validation-connection', accountMode: null, published, sequence: 1,
    policyRevision: 0, catalogue: null, previousCatalogue: null, checkedAt: null, expiresAt: null,
    tools: [
      { name: 'read_order', revision: 'r1', reviewed: true, readOnly: true,
        mode: 'block', suggestion: 'allow' },
      { name: 'update_order', revision: 'r1', reviewed: false, readOnly: false,
        mode: 'block', suggestion: 'ask' },
    ],
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchSpy: MockInstance<typeof fetch>;

function create(
  integration: IntegrationRow,
  policyReply: Response = response(policy(false)),
): ComponentFixture<IntegrationDetail> {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(listResponse(integration)))
    .mockResolvedValueOnce(policyReply);
  const fixture = TestBed.createComponent(IntegrationDetail);
  fixture.componentRef.setInput('serverId', 'fixture-server');
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<IntegrationDetail>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected detail root');
  return element;
}

function driftPolicy(): ToolPolicy {
  const before = { name: 'old_tool', revision: 'a'.repeat(64), reviewed: false,
    definition: JSON.stringify({ name: 'old_tool', description: 'Before',
      inputSchema: { type: 'object' } }) };
  const after = { name: '<img src=x onerror=alert(1)>', revision: 'b'.repeat(64),
    reviewed: false, definition: JSON.stringify({
      name: '<img src=x onerror=alert(1)>', description: '<img src=x onerror=alert(1)>',
      inputSchema: { type: 'object' },
    }) };
  const current = policy(false);
  return { ...current, driftHeld: true, catalogue: { serverId: 'fixture-server',
    toolCount: 1, schemaDigest: 'c'.repeat(64),
    checkedAt: loadedAt, expiresAt: '2026-10-05T09:19:00.000Z', tools: [after] },
  previousCatalogue: { serverId: 'fixture-server', toolCount: 1,
    schemaDigest: 'd'.repeat(64), checkedAt: loadedAt,
    expiresAt: '2026-10-05T09:19:00.000Z', tools: [before] },
  checkedAt: loadedAt, expiresAt: null,
  tools: [{ name: after.name, revision: after.revision, reviewed: false,
    readOnly: false, mode: 'block', suggestion: 'ask' }] };
}

function createChanges(policyReply: Response): ComponentFixture<IntegrationDetail> {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
    .mockResolvedValueOnce(policyReply);
  const fixture = TestBed.createComponent(IntegrationDetail);
  fixture.componentRef.setInput('serverId', 'fixture-server');
  fixture.componentRef.setInput('view', 'changes');
  fixture.detectChanges();
  return fixture;
}

describe('integration detail', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [IntegrationDetail] }));
  afterEach(() => fetchSpy?.mockRestore());

  it('shows drift, counts and expired evidence on the detail page', async () => {
    const fixture = create(row('ready', 'Published'), response(driftPolicy()));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Found 1 added'));
    expect(root(fixture).textContent).toContain('Fixture server is paused: its tools changed');
    expect(root(fixture).textContent).toContain('Last check expired:');
    expect(root(fixture).textContent).toContain('Calls stay paused');
    const changesLink = root(fixture)
      .querySelector('a[href="/org/integrations/fixture-server/changes"]');
    expect(changesLink?.textContent).toContain('Review changes');
    expect(root(fixture).textContent).not.toContain('Draft — review not finished');
    fixture.destroy();
  });

  it('shows an expired check without a drift banner or review-changes action', async () => {
    const expired = { ...driftPolicy(), driftHeld: false, previousCatalogue: null };
    const fixture = create(row('ready', 'Published'), response(expired));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Last check expired:'));
    expect(root(fixture).textContent).not.toContain('is paused: its tools changed');
    expect(root(fixture).textContent).not.toContain('Review changes');
    expect(root(fixture).textContent).not.toContain('Run check now');
    fixture.destroy();
  });

  it('renders untrusted comparison text without HTML or check actions', async () => {
    const fixture = createChanges(response(driftPolicy()));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(2));
    expect(root(fixture).textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root(fixture).querySelector('img')).toBeNull();
    expect(root(fixture).textContent).toContain('Block (new)');
    expect(root(fixture).textContent).toContain('Removed');
    expect(root(fixture).textContent).toContain("There's no rollback.");
    expect(root(fixture).textContent).not.toContain('Run check now');
    expect(root(fixture).textContent).not.toContain('Watch failed');
    fixture.destroy();
  });

  it('clears comparison rows after a refused tools read', async () => {
    const fixture = createChanges(new Response(null, { status: 401 }));
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('Fixture server');
    fixture.destroy();
  });

  it.each([
    ['503', new Response(null, { status: 503 })],
    ['bad JSON', response({ unexpected: true })],
  ])('shows a visible policy failure for %s without claiming review is ready',
    async (_reason, policyReply) => {
      const fixture = createChanges(policyReply);
      await vi.waitFor(() => expect(root(fixture).querySelector('.policy-failure')).not.toBeNull());
      const notice = root(fixture).querySelector('.policy-failure');
      expect(notice?.textContent).toContain("Couldn't check the tool policy");
      expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(0);
      expect(root(fixture).textContent).not.toContain('Review tools');
      fixture.destroy();
    });

  it('keeps comparison rows and labels their check time after a policy refresh fails', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
      .mockResolvedValueOnce(response(driftPolicy()))
      .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.componentRef.setInput('view', 'changes');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(2));
    const refresh = root(fixture).querySelector<HTMLButtonElement>('#integration-refresh');
    refresh?.click();
    await vi.waitFor(() => expect(root(fixture).querySelector('.policy-failure')).not.toBeNull());
    expect(root(fixture).querySelector('.policy-failure')?.textContent)
      .toContain('last successful read');
    expect(root(fixture).textContent).toContain('5 Oct 2026, 09:14 UTC');
    expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(2);
    fixture.destroy();
  });

  it('shows no comparison after a refused register read', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.componentRef.setInput('view', 'changes');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('keeps comparison rows after a failed refresh', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
      .mockResolvedValueOnce(response(driftPolicy()))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.componentRef.setInput('view', 'changes');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't check"));
    const refresh = root(fixture).querySelector<HTMLButtonElement>('#integration-refresh');
    refresh?.click();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(2));
    refresh?.click();
    await vi.waitFor(() => expect(root(fixture).textContent)
      .toContain('The details below are from the last successful read.'));
    expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(2);
    fixture.destroy();
  });

  it('ignores a late changes reply after access ends', async () => {
    let finishTools!: (reply: Response) => void;
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(listResponse(row('ready', 'Published'))))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishTools = resolve;
      }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.componentRef.setInput('view', 'changes');
    fixture.detectChanges();
    await vi.waitFor(() => expect(finishTools).toBeTypeOf('function'));
    fixture.componentInstance.isAccessRefusal(new Response(null, { status: 403 }));
    finishTools(response(driftPolicy()));
    await fixture.whenStable();
    expect(root(fixture).querySelectorAll('.change-row')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('old_tool');
    fixture.destroy();
  });

  it('shows the review notice only for a row pending review', async () => {
    const fixture = create(row('needs_input', 'Pending review · tools changed'));
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('1 of 2 tools reviewed'));
    expect(root(fixture).textContent).toContain('Continue review');
    fixture.destroy();
  });

  it('does not call a connection-required row a draft', async () => {
    const connection = row('needs_input',
      'A scoped validation connection is required. Protected discovery is not available yet.');
    const secondFixture = create(connection);
    await vi.waitFor(() => expect(root(secondFixture).textContent).toContain('Manage tools'));
    expect(root(secondFixture).textContent).not.toContain('Draft — review not finished');
    expect(root(secondFixture).textContent).not.toContain('Continue review');
    secondFixture.destroy();
  });

  it('shows the four facts in order and does not claim grants for unpublished servers', async () => {
    const fixture = create(row('disabled', 'Unpublished 5 Oct 2026, 09:14'));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4));
    const labels = [...root(fixture).querySelectorAll('.fact h3')];
    const labelTexts = labels.map(readHeading);
    expect(labelTexts).toEqual([
      'Installed', 'Connected', 'Allowed for', 'Available to the assistant',
    ]);
    expect(root(fixture).textContent).toContain('Not available yet');
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent).toContain('No');
    expect(root(fixture).querySelectorAll('.fact')[1]?.textContent).toContain('Not available yet');
    expect(root(fixture).querySelectorAll('.fact')[2]?.textContent).toContain('Not available yet');
    const text = root(fixture).textContent ?? '';
    expect(text.match(/\b\d{2}:\d{2}\b/gu)).toEqual(['09:14', '09:14']);
    fixture.destroy();
  });

  it('does not confirm access for a published server', async () => {
    const fixture = create(row('ready', 'Published 5 Oct 2026, 09:14'), response(policy(true)));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4));
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent)
      .toContain('Not available yet');
    fixture.destroy();
  });

  it('does not read tools for a server missing from the register', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ rows: [], loadedAt }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'missing');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Integration not found'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('keeps the other facts when the tools read fails', async () => {
    const fixture = create(row('disabled', 'Unpublished 5 Oct 2026, 09:14'),
      response({ status: 'unavailable' }, 503));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4));
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent).toContain("Couldn't check");
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent).not.toContain('Checking');
    expect(root(fixture).querySelectorAll('.fact')[1]?.textContent).toContain('Not available yet');
    expect(root(fixture).querySelectorAll('.fact')[2]?.textContent).toContain('Not available yet');
    expect(root(fixture).textContent).toContain('Refresh');
    fixture.destroy();
  });

  it('shows the list failure and keeps Refresh after a tools failure', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(listResponse(row('disabled', 'Unpublished 5 Oct 2026, 09:14'))))
      .mockResolvedValueOnce(response({ status: 'unavailable' }, 503))
      .mockResolvedValueOnce(response({ status: 'unavailable' }, 503));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't check"));
    const refresh = root(fixture).querySelector<HTMLButtonElement>('button');
    if (!refresh) throw new Error('Expected a detail refresh button');
    refresh.click();
    await vi.waitFor(() => expect(root(fixture).textContent)
      .toContain("Couldn't load this integration."));
    expect(root(fixture).textContent).not.toContain('Published, but access grants');
    expect(root(fixture).textContent).toContain('Unpublished 5 Oct 2026, 09:14');
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent)
      .toContain("Not checked: the integration list couldn't be loaded.");
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent).not.toContain('Checking');
    expect(root(fixture).querySelector('button')?.textContent).toContain('Refresh');
    fixture.destroy();
  });

  it('hides an old failure after the list refresh succeeds while tools are still loading', async () => {
    let finishList!: (reply: Response) => void;
    let finishPolicy!: (reply: Response) => void;
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ status: 'unavailable' }, 503))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishList = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishPolicy = resolve;
      }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent)
      .toContain("Couldn't load this integration."));
    root(fixture).querySelector<HTMLButtonElement>('#integration-message-refresh')?.click();
    finishList(response(listResponse(row('ready', 'Published 5 Oct 2026, 09:14'))));
    await vi.waitFor(() => expect(finishPolicy).toBeTypeOf('function'));
    expect(root(fixture).textContent).not.toContain("Couldn't load this integration.");
    expect(root(fixture).querySelector('.status-region')?.textContent)
      .toContain('Refreshing integration…');
    finishPolicy(response(policy(true)));
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4));
    fixture.destroy();
  });

  it('moves focus from the first-load Refresh button when the row appears', async () => {
    let finishList!: (reply: Response) => void;
    let finishPolicy!: (reply: Response) => void;
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ status: 'unavailable' }, 503))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishList = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishPolicy = resolve;
      }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent)
      .toContain("Couldn't load this integration."));
    const messageRefresh = root(fixture)
      .querySelector<HTMLButtonElement>('#integration-message-refresh');
    if (!messageRefresh) throw new Error('Expected the message-state Refresh button');
    messageRefresh.focus();
    messageRefresh.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true,
    }));
    messageRefresh.click();
    finishList(response(listResponse(row('ready', 'Published 5 Oct 2026, 09:14'))));
    await vi.waitFor(() => expect(finishPolicy).toBeTypeOf('function'));
    await vi.waitFor(() => expect(globalThis.document.activeElement?.id)
      .toBe('integration-refresh'));
    expect(globalThis.document.activeElement).not.toBe(globalThis.document.body);
    finishPolicy(response(policy(true)));
    fixture.destroy();
  });

  it('keeps focus on Refresh and announces a successful detail refresh', async () => {
    let finishList!: (reply: Response) => void;
    let finishPolicy!: (reply: Response) => void;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === '/api/org/integrations') {
        return Promise.resolve(response(listResponse(row('ready',
          'Published 5 Oct 2026, 09:14'))));
      }
      return Promise.resolve(response({ status: 'unavailable' }, 503));
    });
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).textContent).toContain("Couldn't check"));
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishList = resolve;
    })).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishPolicy = resolve;
    }));
    const refresh = [...root(fixture).querySelectorAll('button')]
      .find((buttonElement) => buttonElement.textContent?.trim() === 'Refresh');
    if (!refresh) throw new Error('Expected a detail refresh button');
    refresh.focus();
    refresh.click();
    fixture.detectChanges();
    expect(globalThis.document.activeElement).toBe(refresh);
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    finishList(response(listResponse(row('ready', 'Published 5 Oct 2026, 09:14'))));
    await vi.waitFor(() => expect(finishPolicy).toBeTypeOf('function'));
    finishPolicy(response(policy(true)));
    await vi.waitFor(() => expect(root(fixture).querySelector('[role="status"]')?.textContent)
      .toContain('Integration details loaded.'));
    expect(root(fixture).querySelector('button')).toBe(refresh);
    expect(globalThis.document.activeElement).toBe(refresh);
    fixture.destroy();
  });


  it('clears the page after access is refused', async () => {
    const fixture = create(row('ready', 'Published 5 Oct 2026, 09:14'),
      new Response(null, { status: 403 }));
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelectorAll('.fact')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('Fixture server');
    expect(root(fixture).querySelector('.access-state h2'))
      .toBe(globalThis.document.activeElement);
    fixture.destroy();
  });

  it('focuses access lost after protected detail content was visible', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(listResponse(
        row('ready', 'Published 5 Oct 2026, 09:14'),
      )))
      .mockResolvedValueOnce(response({ status: 'unavailable' }, 503))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4));
    const refresh = [...root(fixture).querySelectorAll('button')]
      .find((buttonElement) => buttonElement.textContent?.trim() === 'Refresh');
    if (!refresh) throw new Error('Expected a detail refresh button');
    refresh.click();
    await vi.waitFor(() => expect(root(fixture).querySelector('.access-state')).not.toBeNull());
    expect(root(fixture).querySelector('.access-state h2'))
      .toBe(globalThis.document.activeElement);
    fixture.destroy();
  });

  it('does not restore tools after access is refused while their read is pending', async () => {
    let toolsSignal: AbortSignal | null | undefined;
    let finishTools: ((reply: Response) => void) | undefined;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      const url = requestUrl(input);
      if (url === '/api/org/integrations') {
        return Promise.resolve(response(listResponse(
          row('ready', 'Published 5 Oct 2026, 09:14'),
        )));
      }
      toolsSignal = options?.signal;
      return new Promise<Response>((resolve) => { finishTools = resolve; });
    });
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(toolsSignal).toBeDefined());
    refuseDetailAccess(fixture);
    fixture.detectChanges();
    expect(root(fixture).querySelector('.access-state')).not.toBeNull();
    finishTools?.(response(policy(true)));
    await fixture.whenStable();
    expect(toolsSignal?.aborted).toBe(true);
    expect(root(fixture).querySelectorAll('.fact')).toHaveLength(0);
    expect(root(fixture).textContent).not.toContain('Fixture server');
    fixture.destroy();
  });

  it('aborts an in-flight tools read when the detail page is destroyed', async () => {
    let toolsSignal: AbortSignal | null | undefined;
    let finishTools: ((reply: Response) => void) | undefined;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
      const url = requestUrl(input);
      if (url === '/api/org/integrations') {
        return Promise.resolve(response(listResponse(
          row('ready', 'Published 5 Oct 2026, 09:14'),
        )));
      }
      toolsSignal = options?.signal;
      return new Promise<Response>((resolve) => { finishTools = resolve; });
    });
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture-server');
    fixture.detectChanges();
    await vi.waitFor(() => expect(toolsSignal).toBeDefined());
    fixture.destroy();
    expect(toolsSignal?.aborted).toBe(true);
    finishTools?.(response(policy(false)));
    await Promise.resolve();
    expect(root(fixture).querySelectorAll('.fact')).toHaveLength(4);
    expect(root(fixture).querySelectorAll('.fact')[3]?.textContent).toContain('Checking');
  });
});

function readHeading(heading: Element): string {
  return heading.textContent?.trim() ?? '';
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function refuseDetailAccess(fixture: ComponentFixture<IntegrationDetail>): void {
  const response = new Response(null, { status: 403 });
  if (!fixture.componentInstance.isAccessRefusal(response)) {
    throw new Error('Expected the detail read to refuse access');
  }
}
