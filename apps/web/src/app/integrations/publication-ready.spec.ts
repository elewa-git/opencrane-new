import { TestBed } from '@angular/core/testing';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import { IntegrationDetail } from './integration-detail';
import { isReadyPublication } from './publication-ready';
import { bindInitialToolModes } from './review-command';

function readyStatus() {
  return {
    status: 'ready', changeRef: 'publication', generation: 1,
    fragmentDigest: 'a'.repeat(64), recordDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
    requestedAt: new Date(Date.now() - 2000).toISOString(),
    observedAt: new Date(Date.now() - 1000).toISOString(),
  };
}

function readyPolicy(status = readyStatus()): ToolPolicy {
  return toolPolicySchema.parse({
    serverId: 'fixture', sequence: 6, policyRevision: 2, reviewRevision: 4,
    connectionId: 'connection', accountMode: 'none', published: true, tools: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    publication: {
      serverId: 'fixture', commandId: status.changeRef, publishedBy: 'owner',
      expectedSequence: 4, reviewRevision: 4, fragmentDigest: status.fragmentDigest,
    },
    configurationObservation: {
      serverId: 'fixture', changeRef: status.changeRef, reviewRevision: 4,
      fragmentDigest: status.fragmentDigest, sourceSequence: 5, generation: status.generation,
      recordDigest: status.recordDigest, configDigest: status.configDigest,
      processRef: '00000000-0000-4000-8000-000000000001', observedAt: status.observedAt,
    },
  });
}

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

function pendingReply() {
  let finish!: (response: Response) => void;
  function rememberResolver(resolve: (response: Response) => void): void {
    finish = resolve;
  }
  const promise = new Promise<Response>(rememberResolver);
  function release(body: unknown): void {
    finish(reply(body));
  }
  return { promise, release };
}

describe('exact publication evidence', () => {
  it('accepts matching current evidence', () => {
    const status = readyStatus();
    expect(isReadyPublication(status, readyPolicy(status), true)).toBe(true);
  });

  it.each([
    ['serverId', 'another-server'], ['changeRef', 'another-change'],
    ['reviewRevision', 3], ['generation', 2], ['sourceSequence', 4],
    ['sourceSequence', 7],
  ] as const)('rejects receipt %s = %s', (field, value) => {
    const status = readyStatus();
    const policy = readyPolicy(status);
    const receipt = policy.configurationObservation;
    if (!receipt) throw new Error('Expected a saved gateway receipt');
    Object.assign(receipt, { [field]: value });
    expect(isReadyPublication(status, policy, true)).toBe(false);
  });

  it('rejects Ready after the policy expires', () => {
    const status = readyStatus();
    const policy = readyPolicy(status);
    policy.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(isReadyPublication(status, policy, true)).toBe(false);
  });

  it('rejects Ready observed before its request', () => {
    const status = readyStatus();
    status.requestedAt = new Date(Date.parse(status.observedAt) + 1).toISOString();
    expect(isReadyPublication(status, readyPolicy(status), true)).toBe(false);
  });
});

describe('staged review bindings', () => {
  it.each([
    ['sequence', 7], ['policyRevision', 3], ['connectionId', 'another-connection'],
    ['accountMode', 'company'], ['catalogue', null],
  ] as const)('refuses a changed %s without replacing the saved modes', (field, value) => {
    const staged = readyPolicy();
    const catalogue = {
      serverId: 'fixture', toolCount: 0, schemaDigest: 'd'.repeat(64),
      checkedAt: new Date().toISOString(), expiresAt: staged.expiresAt, tools: [],
    };
    staged.catalogue = toolPolicySchema.shape.catalogue.parse(catalogue);
    const current = structuredClone(staged);
    Object.assign(current, { [field]: value });
    const savedTools = current.tools;
    expect(bindInitialToolModes(current, staged, false)).toBe(false);
    expect(current.tools).toBe(savedTools);
  });
});

describe('publication status request order', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('keeps Unknown and its recovery reference after older policy and Ready replies', async () => {
    const status = readyStatus();
    const accepted = readyPolicy(status);
    const rejected = structuredClone(accepted);
    rejected.sequence = 7;
    rejected.rejected = true;
    delete rejected.configurationObservation;
    const unknown = { status: 'unknown', changeRef: 'publication' };
    const integration = {
      serverId: 'fixture', name: 'Fixture server', version: '1', accountModel: 'None',
      toolsAllowed: 0, toolsTotal: 0,
      source: { kind: 'remote_url', label: 'Remote URL', detail: 'example.test' },
      status: { kind: 'draft', label: 'Draft', detail: 'Review tools' },
    };
    sessionStorage.setItem('integration-publication:fixture', 'publication');
    const policyReplies = [Promise.resolve(reply(accepted)), Promise.resolve(reply(accepted))];
    const statusReplies = [Promise.resolve(reply(unknown))];
    function readReply(input: RequestInfo | URL): Promise<Response> {
      const url = String(input);
      if (url.endsWith('/tools')) {
        const next = policyReplies.shift();
        if (!next) throw new Error('Unexpected policy read');
        return next;
      }
      if (url.includes('/changes/')) {
        const next = statusReplies.shift();
        if (!next) throw new Error('Unexpected status read');
        return next;
      }
      if (url.endsWith('/integrations')) {
        return Promise.resolve(reply({ rows: [integration], loadedAt: status.observedAt }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(readReply);
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture');
    fixture.componentRef.setInput('view', 'changes');
    fixture.componentRef.setInput('initialPolicy', accepted);
    fixture.changeDetectorRef.detach();
    fixture.detectChanges();
    const component = fixture.componentInstance;
    await vi.waitFor(function initialCheckFinished() {
      expect(component['changeState']()).toBe('unknown-publication');
    });

    const olderPolicy = pendingReply();
    const olderReady = pendingReply();
    policyReplies.push(olderPolicy.promise);
    const firstCheck = component['checkPublicationChange']();
    policyReplies.push(Promise.resolve(reply(accepted)));
    statusReplies.push(olderReady.promise);
    const secondCheck = component['checkPublicationChange']();
    function isStatusRead(call: Parameters<typeof fetch>): boolean {
      return String(call[0]).includes('/changes/');
    }
    await vi.waitFor(function readyReadStarted() {
      const statusReads = fetchMock.mock.calls.filter(isStatusRead);
      expect(statusReads).toHaveLength(2);
    });
    policyReplies.push(Promise.resolve(reply(rejected)));
    statusReplies.push(Promise.resolve(reply(unknown)));
    await component['checkPublicationChange']();
    expect(component['policy']()?.sequence).toBe(7);

    // Release both old replies after the latest check has shown Unknown.
    statusReplies.push(Promise.resolve(reply(unknown)));
    olderPolicy.release(accepted);
    await firstCheck;
    const policyAfterOlderReply = component['policy']()?.sequence;
    olderReady.release(status);
    await secondCheck;
    fixture.detectChanges();
    expect(component['changeState']()).toBe('unknown-publication');
    expect(policyAfterOlderReply).toBe(7);
    expect(component['changeRef']()).toBe('publication');
    expect(sessionStorage.getItem('integration-publication:fixture')).toBe('publication');
    const root: unknown = fixture.nativeElement;
    if (!(root instanceof HTMLElement)) throw new Error('Expected the publication page');
    expect(root.textContent).not.toContain('The current publication is confirmed');
    expect(root.textContent).toContain('Check status');
    fixture.destroy();
  });

  it('keeps the newer policy when a later check reads a lower saved sequence', async () => {
    const fixture = TestBed.createComponent(IntegrationDetail);
    fixture.componentRef.setInput('serverId', 'fixture');
    const component = fixture.componentInstance;
    const current = readyPolicy();
    current.sequence = 7;
    component['policy'].set(current);
    fixture.componentRef.setInput('initialPolicy', current);
    component['publicationCommandId'] = 'publication';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(readyPolicy()));
    await component['checkPublicationChange']();
    expect(component['policy']()?.sequence).toBe(7);
    fixture.destroy();
  });
});
