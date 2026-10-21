import { TestBed } from '@angular/core/testing';
import { toolPolicySchema } from '@opencrane/protocol';
import { reviewCommand } from '../integrations/review-command';
import { initialModeDisabled, initialToolPolicy } from './tool-policy-choices';
import { ToolPolicyScreen } from './tool-policy';

function initialPolicy() {
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 240_000).toISOString();
  const review = { action: 'Read items', consequence: 'Items are read',
    targetArgument: 'item', fields: ['item'], stepUp: false };
  const declaration = { name: 'read_item', revision: 'a'.repeat(64), reviewed: false,
    costCents: 0, review, definition: JSON.stringify({ name: 'read_item',
      description: '<img src=x onerror=alert(1)>', inputSchema: { type: 'object' } }) };
  return toolPolicySchema.parse({ silo: 'test', serverId: 'fixture', sequence: 3,
    policyRevision: 2, connectionId: 'connection', accountMode: 'none', published: false,
    checkedAt, expiresAt, catalogue: { serverId: 'fixture', toolCount: 1,
      schemaDigest: 'b'.repeat(64), checkedAt, expiresAt, tools: [declaration] },
    tools: [{ name: 'read_item', revision: declaration.revision, reviewed: false,
      readOnly: true, mode: 'block', suggestion: 'allow', costCents: 0 }] });
}

afterEach(() => vi.restoreAllMocks());

it('binds the first exact review without a previous catalogue', async () => {
  const policy = initialPolicy();
  const command = await reviewCommand(policy, 'initial-review');
  expect(command).toMatchObject({ expectedSequence: 3, policyRevision: 2,
    connectionId: 'connection', accountMode: 'none', catalogueDigest: 'b'.repeat(64),
    tools: [{ name: 'read_item', revision: 'a'.repeat(64), mode: 'block' }] });
  expect(command.tools[0]?.reviewDigest).toMatch(/^[a-f0-9]{64}$/u);
});

function servePolicy(policy: ReturnType<typeof initialPolicy>, unavailable = false) {
  function read(input: RequestInfo | URL) {
    const address = input instanceof Request ? input.url : input.toString();
    if (address.endsWith('/access')) {
      if (unavailable) return Promise.resolve(new Response('{}', { status: 503 }));
      const response = new Response(JSON.stringify({ serverId: 'fixture', expectedSequence: 0,
        loadedAt: new Date().toISOString(), canManage: true, grants: [], complete: true,
        grantTotal: 0, projection: { content: 'current', iam: 'current', sequence: 0 } }));
      return Promise.resolve(response);
    }
    return Promise.resolve(new Response(JSON.stringify(policy)));
  }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(read);
}

it('starts blocked and stages an initial mode without sending a command', async () => {
  const policy = initialPolicy();
  const fetchMock = servePolicy(policy);
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected tools');
  await vi.waitFor(() => expect(root.querySelector('fieldset')?.disabled).toBe(false));
  const blocked = root.querySelector<HTMLInputElement>('input[value="block"]');
  expect(blocked?.checked).toBe(true);
  const allow = root.querySelector<HTMLInputElement>('input[value="allow"]');
  allow?.click();
  fixture.detectChanges();
  expect(allow?.checked).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(root.textContent).toContain('Review access');
  fixture.destroy();
});

it.each(['cost', 'details'])('keeps initial Allow and Ask blocked without %s', async (missing) => {
  const policy = initialPolicy();
  const declaration = policy.catalogue?.tools?.[0];
  if (!declaration) throw new Error('Expected declaration');
  if (missing === 'cost') delete declaration.costCents;
  else delete declaration.review;
  policy.tools[0]!.mode = 'allow';
  const command = await reviewCommand(policy, 'initial-review');
  expect(command.tools[0]?.mode).toBe('block');
  policy.tools[0]!.mode = 'ask';
  const ask = await reviewCommand(policy, 'ask-review');
  expect(ask.tools[0]?.mode).toBe('block');
});

it('changes the review digest when declared approval details change', async () => {
  const policy = initialPolicy();
  const first = await reviewCommand(policy, 'first-review');
  const declaration = policy.catalogue?.tools?.[0];
  if (!declaration?.review) throw new Error('Expected approval details');
  declaration.review.consequence = 'Different consequence';
  const second = await reviewCommand(policy, 'second-review');
  expect(first.tools[0]?.reviewDigest).not.toBe(second.tools[0]?.reviewDigest);
});

it('refuses an expired initial snapshot', async () => {
  const policy = initialPolicy();
  policy.expiresAt = new Date(Date.now() - 1000).toISOString();
  await expect(reviewCommand(policy, 'expired-review')).rejects.toThrow();
});

it('keeps reviewed mode editing available when the separate audience read is unavailable', async () => {
  const policy = initialPolicy();
  policy.sequence = 4;
  policy.reviewRevision = 4;
  policy.tools[0]!.reviewed = true;
  expect(initialToolPolicy(policy)).toBe(false);
  expect(initialModeDisabled(policy, 'missing_declaration')).toBe(true);
  servePolicy(policy, true);
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected tools');
  await vi.waitFor(() => expect(root.querySelector('fieldset')?.disabled).toBe(false));
  expect(root.querySelector('button[aria-label="Save mode for read_item"]')).not.toBeNull();
  expect(root.textContent).toContain('Review access');
  fixture.destroy();
});
