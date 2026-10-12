import { expect, it } from 'vitest';
import { egressFixture, type EgressScenario } from './egress-fixture.ts';

async function routesAfterSavedAdmission() {
  const setup = await egressFixture();
  expect(await setup.tunnel(await setup.token())).toBe(200);
  expect(setup.order).toEqual(['authz', 'audit', 'dispatch', 'relay']);
  expect(setup.received().toString()).toBe('native-binary-tunnel');
  expect(setup.actor.state.dispatches).toHaveLength(1);
  expect(await setup.receipts()).toHaveLength(1);
}
it('routes native CONNECT bytes only after extAuthz, saved audit and the existing final gate',
  routesAfterSavedAdmission);

async function blocksBeforeRelay(scenario: EgressScenario) {
  const setup = await egressFixture();
  setup.scenario(scenario);
  expect(await setup.tunnel(await setup.token())).not.toBe(200);
  expect(setup.connected()).toBe(0);
  expect(setup.received()).toHaveLength(0);
  if (scenario === 'stop' || scenario === 'revoke' || scenario === 'gate-outage') {
    expect(await setup.receipts()).toHaveLength(1);
    expect(setup.actor.state.dispatches).toHaveLength(0);
  }
}
const scenarios: EgressScenario[] = ['deny', 'stop', 'revoke', 'audit-outage',
  'gate-outage', 'missing-relay', 'foreign-relay'];
it.each(scenarios)('sends no upstream bytes with %s before handoff', blocksBeforeRelay);

async function refusesRepeatedPermit() {
  const setup = await egressFixture();
  const token = await setup.token();
  expect(await setup.tunnel(token)).toBe(200);
  expect(await setup.tunnel(token)).not.toBe(200);
  expect(setup.connected()).toBe(1);
  expect(setup.actor.state.dispatches).toHaveLength(1);
}
it('gives a repeated permit no second relay connection', refusesRepeatedPermit);

async function refusesForeignAudience(audience: string) {
  const setup = await egressFixture();
  expect(await setup.tunnel(await setup.token(audience))).toBe(401);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it.each(['agentgateway', 'provider-verification'])('refuses %s passes before extAuthz',
  refusesForeignAudience);

async function refusesExpiredPass() {
  const setup = await egressFixture();
  expect(await setup.tunnel(await setup.token('computer-egress', -1))).toBe(401);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it('refuses an expired egress pass before extAuthz', refusesExpiredPass);

async function refusesEgressAudienceOnModelRoute() {
  const setup = await egressFixture();
  const headers = { authorization: `Bearer ${await setup.token()}` };
  const options = { method: 'POST', headers, body: '{}' };
  const response = await fetch(`http://127.0.0.1:${setup.port}/v1/responses`, options);
  expect(response.status).toBe(401);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it('keeps an egress pass out of the model route', refusesEgressAudienceOnModelRoute);
