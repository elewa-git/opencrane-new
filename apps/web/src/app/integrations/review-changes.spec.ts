import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import { z } from 'zod';
import type { MockInstance } from 'vitest';
import { IntegrationDetail } from './integration-detail';

const commandSchema = z.object({
  commandId: z.string(), expectedSequence: z.number(),
  policyRevision: z.number().optional(), catalogueDigest: z.string().optional(),
  connectionId: z.string().optional(), accountMode: z.string().optional(),
  reviewRevision: z.number().optional(),
  tools: z.array(z.object({ name: z.string(), mode: z.string(),
    reviewDigest: z.string() })).optional(),
}).passthrough();

function postedCommand(fetchMock: MockInstance<typeof fetch>, index: number) {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON command');
  const raw: unknown = JSON.parse(body);
  return commandSchema.parse(raw);
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function policy(): ToolPolicy {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 239_000).toISOString();
  const oldDefinition = JSON.stringify({ name: 'update_note', inputSchema: {
    type: 'object', properties: { note: { type: 'string', maxLength: 500 } },
  } });
  const newDefinition = JSON.stringify({ name: 'update_note', inputSchema: {
    type: 'object', properties: { note: { type: 'string', maxLength: 2000 } },
  } });
  const addedDefinition = JSON.stringify({ name: 'confirm_order', inputSchema: {
    type: 'object',
  } });
  const review = { action: 'Update a note', consequence: 'A draft changes',
    targetArgument: 'note', fields: ['note'], stepUp: false };
  const before = [{ name: 'update_note', revision: 'a'.repeat(64), reviewed: true,
    definition: oldDefinition, costCents: 0 }];
  const after = [{ name: 'update_note', revision: 'b'.repeat(64), reviewed: false,
    definition: newDefinition, costCents: 0, review },
  { name: 'confirm_order', revision: 'c'.repeat(64), reviewed: false,
    definition: addedDefinition, costCents: 0 }];
  return { silo: 'test', serverId: 'fixture-server', connectionId: 'connection',
    accountMode: 'none', published: false, driftHeld: true, sequence: 8,
    policyRevision: 7, checkedAt, expiresAt,
    catalogue: { serverId: 'fixture-server', toolCount: 2,
      schemaDigest: 'd'.repeat(64), checkedAt, expiresAt, tools: after },
    previousCatalogue: { serverId: 'fixture-server', toolCount: 1,
      schemaDigest: 'e'.repeat(64), checkedAt, expiresAt, tools: before },
    tools: [{ name: 'update_note', revision: 'b'.repeat(64), reviewed: false,
      readOnly: true, mode: 'ask', suggestion: 'ask', costCents: 0 },
    { name: 'confirm_order', revision: 'c'.repeat(64), reviewed: false,
      readOnly: false, mode: 'block', suggestion: 'ask', costCents: 0 }] };
}

const integration = { serverId: 'fixture-server', name: 'Fixture server',
  source: { kind: 'remote_url', label: 'Remote URL', detail: 'example.test' },
  version: '1', accountModel: 'None', toolsAllowed: 0, toolsTotal: 2,
  status: { kind: 'needs_input', label: 'Needs input', detail: 'Tools changed' } };

function page(): ComponentFixture<IntegrationDetail> {
  const fixture = TestBed.createComponent(IntegrationDetail);
  fixture.componentRef.setInput('serverId', 'fixture-server');
  fixture.componentRef.setInput('view', 'changes');
  fixture.detectChanges();
  return fixture;
}

function content(fixture: ComponentFixture<IntegrationDetail>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected detail root');
  return element;
}

function click(fixture: ComponentFixture<IntegrationDetail>, label: string): void {
  const buttons = [...content(fixture).querySelectorAll('button')];
  const button = buttons.find((item) => item.textContent?.includes(label));
  expect(button).toBeDefined();
  button?.click();
}

describe('reviewed changed tools', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [IntegrationDetail] }));
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('offers review after an earlier publication has drifted', async () => {
    const drifted = policy();
    drifted.reviewRevision = 6;
    drifted.publication = { serverId: 'fixture-server', publishedBy: 'owner',
      commandId: 'earlier-publication', expectedSequence: 6, reviewRevision: 6,
      fragmentDigest: 'f'.repeat(64) };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(drifted))
      .mockResolvedValueOnce(reply({ status: 'applying', changeRef: 'earlier-publication',
        stage: 'preparation', reason: 'not_current' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review and publish'));
    fixture.destroy();
  });

  it('checks a saved earlier publication then offers review of newer drift', async () => {
    const drifted = policy();
    drifted.reviewRevision = 6;
    drifted.publication = { serverId: 'fixture-server', publishedBy: 'owner',
      commandId: 'earlier-publication', expectedSequence: 6, reviewRevision: 6,
      fragmentDigest: 'f'.repeat(64) };
    sessionStorage.setItem('integration-publication:fixture-server', 'earlier-publication');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(drifted))
      .mockResolvedValueOnce(reply({ status: 'applying', changeRef: 'earlier-publication',
        stage: 'preparation', reason: 'not_current' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review and publish'));
    expect(requestUrl(fetchMock.mock.calls[2]?.[0]))
      .toBe('/api/org/integrations/changes/earlier-publication');
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBeNull();
    expect(content(fixture).textContent).not.toContain('Check status');
    fixture.destroy();
  });

  it('keeps a saved publication uncertain for the current policy', async () => {
    sessionStorage.setItem('integration-publication:fixture-server', 'current-publication');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'unknown', changeRef: 'current-publication',
        stage: 'observation', reason: 'deadline' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Check status'));
    expect(requestUrl(fetchMock.mock.calls[2]?.[0]))
      .toBe('/api/org/integrations/changes/current-publication');
    expect(sessionStorage.getItem('integration-publication:fixture-server'))
      .toBe('current-publication');
    expect(content(fixture).textContent).not.toContain('Review and publish');
    fixture.destroy();
  });

  it('discards an invalid saved reference before checking publication', async () => {
    sessionStorage.setItem('integration-publication:fixture-server', 'invalid/reference');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review and publish'));
    expect(requestUrl(fetchMock.mock.calls[2]?.[0]))
      .toBe('/api/org/integrations/fixture-server/publication');
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBeNull();
    fixture.destroy();
  });

  it('clears a saved reference after the original publication is confirmed', async () => {
    sessionStorage.setItem('integration-publication:fixture-server', 'confirmed-publication');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'ready', changeRef: 'confirmed-publication',
        generation: 1, fragmentDigest: 'f'.repeat(64), recordDigest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64), requestedAt: new Date(Date.now() - 1000).toISOString(),
        observedAt: new Date().toISOString() }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent)
      .toContain('The current publication is confirmed'));
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBeNull();
    fixture.destroy();
  });

  it('clears a saved reference when the original status read refuses access', async () => {
    sessionStorage.setItem('integration-publication:fixture-server', 'refused-publication');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).querySelector('.access-state'))
      .not.toBeNull());
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBeNull();
    expect(content(fixture).textContent).not.toContain('Review and publish');
    fixture.destroy();
  });

  it.each(['missing', 'equal'])('withholds review when the earlier list is %s', async (kind) => {
    const incomplete = policy();
    if (kind === 'missing') incomplete.previousCatalogue = null;
    else incomplete.previousCatalogue = incomplete.catalogue;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(incomplete))
      .mockResolvedValueOnce(reply({ status: 'disabled' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('comparison is unavailable'));
    expect(content(fixture).textContent).not.toContain('Review and publish');
    fixture.destroy();
  });

  it('shows the complete schema when a field and a schema setting change', async () => {
    const changed = policy();
    const declaration = changed.catalogue?.tools?.[0];
    if (!declaration) throw new Error('Expected tool');
    declaration.definition = JSON.stringify({ name: 'update_note',
      description: '<img src=x onerror=alert(1)>', inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { note: { type: 'string', maxLength: 2000 } },
    } });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(changed))
      .mockResolvedValueOnce(reply({ status: 'disabled' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).querySelector('details')).not.toBeNull());
    expect(content(fixture).querySelectorAll('details')[1]?.textContent)
      .toContain('"additionalProperties": false');
    expect(content(fixture).querySelectorAll('details')[1]?.textContent)
      .toContain('"maxLength": 2000');
    expect(content(fixture).querySelectorAll('details')[1]?.textContent)
      .toContain('<img src=x onerror=alert(1)>');
    expect(content(fixture).querySelector('details img')).toBeNull();
    fixture.destroy();
  });

  it('checks the original uncertain publication after reopening without another POST', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: 9 }))
      .mockRejectedValueOnce(new Error('lost publication reply'))
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()));
    const first = page();
    await vi.waitFor(() => expect(content(first).textContent).toContain('Review and publish'));
    click(first, 'Review and publish');
    await vi.waitFor(() => expect(content(first).textContent).toContain('Check status'));
    const originalId = postedCommand(fetchMock, 4).commandId;
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBe(originalId);
    first.destroy();
    fetchMock.mockResolvedValueOnce(reply({ status: 'unknown', changeRef: originalId,
        stage: 'observation', reason: 'deadline' }));
    const fixture = page();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    expect(requestUrl(fetchMock.mock.calls[7]?.[0]))
      .toBe(`/api/org/integrations/changes/${originalId}`);
    expect(content(fixture).textContent).toContain('Check status');
    expect(content(fixture).textContent).not.toContain('Review and publish');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
    fixture.destroy();
  });

  it('keeps a deadline reply reference available for status checks', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'unknown', changeRef: 'deadline-publication',
        stage: 'receipt', reason: 'deadline' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Check status'));
    expect(content(fixture).textContent).toContain('deadline-publication');
    expect(sessionStorage.getItem('integration-publication:fixture-server'))
      .toBe('deadline-publication');
    fixture.destroy();
  });

  it.each(['no drift hold', 'no connection', 'no account mode', 'expired'])(
    'withholds review when the policy has %s', async (reason) => {
    const unavailable = policy();
    if (reason === 'no drift hold') unavailable.driftHeld = false;
    if (reason === 'no connection') unavailable.connectionId = null;
    if (reason === 'no account mode') unavailable.accountMode = null;
    if (reason === 'expired') unavailable.expiresAt = new Date(Date.now() - 1000).toISOString();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(unavailable))
      .mockResolvedValueOnce(reply({ status: 'disabled' }));
    const fixture = page();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(content(fixture).querySelectorAll('.change-row'))
      .toHaveLength(2));
    expect(content(fixture).textContent).not.toContain('Review and publish');
    fixture.destroy();
    },
  );

  it('blocks a second decision after publication returns 409', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: 248 }))
      .mockResolvedValueOnce(reply({ status: 'conflict' }, 409));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review and publish'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review again'));
    expect(content(fixture).textContent).not.toContain('Review and publish');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
    expect(sessionStorage.getItem('integration-publication:fixture-server')).toBeNull();
    fixture.destroy();
  });

  it('shows schema values as text, keeps Ask and gives the new tool Block', async () => {
    expect(toolPolicySchema.safeParse(policy())).toMatchObject({ success: true });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    expect(content(fixture).textContent).toContain('maxLength: 500');
    expect(content(fixture).textContent).toContain('Block (new)');
    expect(content(fixture).textContent).toContain('Ask');
    expect(content(fixture).textContent).toContain('Old approvals stay ended');
    fixture.destroy();
  });

  async function publishesReturnedPositions(reviewPosition: number, publicationPosition: number) {
    function currentStatus(): Promise<Response> {
      const body = postedCommand(fetchMock, 4);
      return Promise.resolve(reply({ status: 'applying', changeRef: body.commandId }));
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: reviewPosition }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: publicationPosition }))
      .mockImplementationOnce(currentStatus);
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent)
      .toContain('Publishing the reviewed tool list'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    const review = postedCommand(fetchMock, 3);
    const publication = postedCommand(fetchMock, 4);
    expect(review).toMatchObject({ expectedSequence: 8, policyRevision: 7,
      catalogueDigest: 'd'.repeat(64), connectionId: 'connection', accountMode: 'none' });
    expect(review.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'update_note', mode: 'ask',
        reviewDigest: 'cbb22f0f6ee74151de8abc96912dcca08942e943cdb2740e13d7ae8b20af7ca2' }),
      expect.objectContaining({ name: 'confirm_order', mode: 'block' }),
    ]));
    expect(publication).toMatchObject({ expectedSequence: reviewPosition,
      reviewRevision: reviewPosition });
    expect(content(fixture).textContent).not.toContain('Ready');
    fixture.destroy();
  }
  const publicationPositions = [[9, 10], [248, 252]] as const;
  it.each(publicationPositions)(
    'publishes review position %s and checks publication position %s', publishesReturnedPositions);

  it('requires a fresh read after a stale review', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'conflict' }, 409));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Review again'));
    expect(fetchMock.mock.calls.filter((call) => requestUrl(call[0]).includes('/publication')))
      .toHaveLength(1);
    fixture.destroy();
  });

  it('checks an unknown publication only by its original change id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: 9 }))
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValueOnce(reply({ status: 'ready', changeRef: 'another-change' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Check status'));
    click(fixture, 'Check status');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(requestUrl(fetchMock.mock.calls[5]?.[0])).toMatch(/\/changes\//);
    expect(content(fixture).textContent).not.toContain('The current publication is confirmed');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST'))
      .toHaveLength(2);
    fixture.destroy();
  });

  it('clears protected rows and ignores a late review receipt after access ends', async () => {
    let finishReview!: (response: Response) => void;
    function saveResolver(resolve: (response: Response) => void): void {
      finishReview = resolve;
    }
    function waitForReview(): Promise<Response> {
      return new Promise<Response>(saveResolver);
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockImplementationOnce(waitForReview);
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).querySelectorAll('.change-row')).toHaveLength(2));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    fixture.componentInstance.isAccessRefusal(new Response(null, { status: 403 }));
    finishReview(reply({ status: 'appended', sequence: 9 }));
    await vi.waitFor(() => expect(content(fixture).querySelector('.access-state')).not.toBeNull());
    expect(content(fixture).querySelectorAll('.change-row')).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fixture.destroy();
  });
});
