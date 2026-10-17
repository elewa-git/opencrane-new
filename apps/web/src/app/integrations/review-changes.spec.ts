import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import { IntegrationDetail } from './integration-detail';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function policy(): ToolPolicy {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 240_000).toISOString();
  const oldDefinition = JSON.stringify({ name: 'update_note', inputSchema: {
    type: 'object', properties: { note: { type: 'string', maxLength: 500 } },
  } });
  const newDefinition = JSON.stringify({ name: 'update_note', inputSchema: {
    type: 'object', properties: { note: { type: 'string', maxLength: 2000 } },
  } });
  const addedDefinition = JSON.stringify({ name: 'confirm_order', inputSchema: {
    type: 'object',
  } });
  const before = [{ name: 'update_note', revision: 'a'.repeat(64), reviewed: true,
    definition: oldDefinition, costCents: 0 }];
  const after = [{ name: 'update_note', revision: 'b'.repeat(64), reviewed: false,
    definition: newDefinition, costCents: 0 },
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
  return fixture.nativeElement as HTMLElement;
}

function click(fixture: ComponentFixture<IntegrationDetail>, label: string): void {
  const buttons = [...content(fixture).querySelectorAll('button')];
  const button = buttons.find((item) => item.textContent?.includes(label));
  expect(button).toBeDefined();
  button?.click();
}

describe('reviewed changed tools', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [IntegrationDetail] }));
  afterEach(() => vi.restoreAllMocks());

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

  it('reviews the exact read before publishing the returned revision', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply({ rows: [integration], loadedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(reply(policy()))
      .mockResolvedValueOnce(reply({ status: 'disabled' }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: 9 }))
      .mockResolvedValueOnce(reply({ status: 'appended', sequence: 10 }))
      .mockResolvedValueOnce(reply({ status: 'applying', changeRef: 'change-test' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent)
      .toContain('Publishing the reviewed tool list'));
    const review = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    const publication = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
    expect(review).toMatchObject({ expectedSequence: 8, policyRevision: 7,
      catalogueDigest: 'd'.repeat(64), connectionId: 'connection', accountMode: 'none' });
    expect(review.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'update_note', mode: 'ask' }),
      expect.objectContaining({ name: 'confirm_order', mode: 'block' }),
    ]));
    expect(publication).toMatchObject({ expectedSequence: 9, reviewRevision: 9 });
    expect(content(fixture).textContent).not.toContain('Ready');
    fixture.destroy();
  });

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
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/publication')))
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
      .mockResolvedValueOnce(reply({ status: 'unknown', stage: 'read', reason: 'unavailable' }));
    const fixture = page();
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('maxLength: 2000'));
    click(fixture, 'Review and publish');
    await vi.waitFor(() => expect(content(fixture).textContent).toContain('Check status'));
    click(fixture, 'Check status');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(String(fetchMock.mock.calls[5]?.[0])).toMatch(/\/changes\//);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST'))
      .toHaveLength(2);
    fixture.destroy();
  });
});
