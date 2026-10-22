export function journeyIntegrationRegistration(serverId: string) {
  return { serverId, kind: 'remote' as const, locator: 'https://mcp.example.test/mcp',
    catalogueRef: 'catalogue:dev', registeredBy: 'dev-only-bootstrap' };
}
