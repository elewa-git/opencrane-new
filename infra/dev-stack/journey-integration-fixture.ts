export function journeyIntegrationRegistration(serverId: string) {
  // Use a hosted display fixture: no tools are called and no remote URL needs monitoring.
  const locator = `localhost/journey/typed-rows@sha256:${'0'.repeat(64)}`;
  const credentialContract = { credentialMode: 'per_call' as const };
  return { serverId, kind: 'hosted' as const, locator,
    credentialContract, catalogueRef: 'catalogue:dev', registeredBy: 'dev-only-bootstrap' };
}
