import { TestBed } from '@angular/core/testing';
import { ToolPolicyScreen } from './tool-policy';

it('reads the initial audience before allowing review or another grant', async () => {
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 240_000).toISOString();
  const policy = { silo: 'test', serverId: 'fixture', sequence: 3, policyRevision: 2,
    connectionId: 'connection', accountMode: 'none', published: false, checkedAt, expiresAt,
    catalogue: { serverId: 'fixture', toolCount: 0, schemaDigest: 'b'.repeat(64),
      checkedAt, expiresAt, tools: [] }, tools: [] };
  const paths: string[] = [];
  function read(input: RequestInfo | URL) {
    const path = input instanceof Request ? input.url : input.toString();
    paths.push(path);
    if (path.endsWith('/tools')) return Promise.resolve(new Response(JSON.stringify(policy)));
    return Promise.resolve(new Response('{}', { status: 503 }));
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(read);
  const fixture = TestBed.createComponent(ToolPolicyScreen);
  fixture.componentRef.setInput('serverId', 'fixture');
  fixture.detectChanges();
  function audienceRead() {
    expect(paths).toContain('/api/org/integrations/fixture/access');
  }
  try {
    await vi.waitFor(audienceRead);
  } finally {
    fixture.destroy();
    vi.restoreAllMocks();
  }
});
