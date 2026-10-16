import { once } from 'node:events';
import { request } from 'node:http';
import { clientHello } from './egress-hello-fixture.ts';
import { expect, it } from 'vitest';
import { egressFixture, type EgressScenario } from './egress-fixture.ts';
import { egressGatewayRoute } from '../src/egress-gateway.ts';
import { history } from '../src/event-history.ts';

async function routesAfterSavedAdmission() {
  const setup = await egressFixture();
  const status = await setup.tunnel(await setup.token());
  expect(status, JSON.stringify(setup.order)).toBe(200);
  expect(setup.order).toEqual(['authz', 'audit', 'dispatch', 'relay']);
  const controlRequest = { method: 'POST', authority: 'registry.npmjs.org:443' };
  expect(setup.controlRequests).toEqual([controlRequest]);
  expect(setup.received().toString()).toBe('native-binary-tunnel');
  expect(setup.actor.state.dispatches).toHaveLength(1);
  expect(setup.actor.state.reservations).toHaveLength(0);
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
  expect(await setup.tunnel(await setup.token('computer-egress', -1))).not.toBe(200);
  expect(await setup.receipts()).toHaveLength(0);
  expect(setup.connected()).toBe(0);
}
it('refuses an expired egress pass before saving admission', refusesExpiredPass);

async function refusesEgressAudienceOnOtherRoute(path: string) {
  const setup = await egressFixture();
  const headers = { authorization: `Bearer ${await setup.token()}` };
  const options = { method: 'POST', headers, body: '{}' };
  const response = await fetch(`http://127.0.0.1:${setup.port}${path}`, options);
  expect(response.status).toBe(401);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it.each(['/v1/responses', '/mcp/fixture/installed'])('keeps an egress pass out of %s',
  refusesEgressAudienceOnOtherRoute);

async function refusesInvalidPass(bearer: string) {
  const setup = await egressFixture();
  expect(await setup.tunnel(bearer)).toBe(401);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it.each(['', 'forged'])('refuses missing or forged pass %j before extAuthz', refusesInvalidPass);

async function refusesUnavailableControl() {
  const setup = await egressFixture();
  const bearer = await setup.token();
  expect(await setup.tunnel(bearer)).toBe(200);
  await setup.decisionDown();
  expect(await setup.tunnel(bearer)).toBe(503);
  expect(setup.connected()).toBe(1);
  expect(setup.received().toString()).toBe('native-binary-tunnel');
}
it('opens no further relay when the real control listener goes down', refusesUnavailableControl);

async function keepsDefaultOff() {
  const setup = await egressFixture(false);
  expect(await setup.tunnel(await setup.token())).toBe(405);
  expect(setup.authorised()).toBe(0);
  expect(setup.connected()).toBe(0);
}
it('keeps CONNECT off when ordinary gateway startup supplies no egress listener', keepsDefaultOff);

function refusesPublicControlListener(url: string) {
  function configureRoute() {
    return egressGatewayRoute(url, 'https://issuer.invalid');
  }
  expect(configureRoute).toThrow('private loopback listener');
}
const publicListeners = ['http://0.0.0.0:4000', 'https://127.0.0.1:4000',
  'http://user@127.0.0.1:4000', 'http://127.0.0.1:4000/control',
  'http://127.0.0.1:4000/?token=canary'];
it.each(publicListeners)('refuses a non-private control address: %s', refusesPublicControlListener);

async function guardedTunnel(bytes: Buffer, connections: number) {
  const setup = await egressFixture(true, true);
  const bearer = await setup.token();
  expect(await setup.tunnel(bearer, 'registry.npmjs.org:443', bytes)).toBe(200);
  expect(setup.connected()).toBe(connections);
  if (connections === 1) expect(setup.received()).toEqual(bytes);
  else expect(setup.received()).toHaveLength(0);
  expect(setup.received().includes(bearer)).toBe(false);
  expect(setup.received().includes('secret-canary')).toBe(false);
  function closedRelays() { return setup.closeRecords.length; }
  await expect.poll(closedRelays).toBe(1);
  await setup.receipt.retry();
  const observations = await history(setup.store, `egress-${setup.permit}`, 'test');
  expect(observations).toHaveLength(0);
}
it.each([[clientHello(), 1], [Buffer.from('GET https://registry.npmjs.org/ HTTP/1.1\r\n\r\n'), 0]])(
  'checks tunnel bytes behind the real gateway before connecting', guardedTunnel);

async function refusesAbsoluteHttp() {
  const setup = await egressFixture(true, true);
  const headers = { 'proxy-authorization': `Bearer ${await setup.token()}` };
  const options = { host: '127.0.0.1', port: setup.port, method: 'GET',
    path: 'https://registry.npmjs.org/', headers };
  const outgoing = request(options);
  const response = once(outgoing, 'response');
  outgoing.end();
  await response;
  expect(setup.connected()).toBe(0);
  expect(setup.received()).toHaveLength(0);
}
it('sends absolute-form plain HTTP to no upstream', refusesAbsoluteHttp);

async function closesRealTunnel(expire: boolean) {
  const setup = await egressFixture(true, true);
  const bearer = await setup.token();
  async function afterEcho(socket: import('node:net').Socket) {
    const started = Date.now();
    const closed = once(socket, 'close');
    if (!expire) setup.registry.closeDestination({ host: 'registry.npmjs.org', port: 443 });
    await closed;
    await expect.poll(setup.activeConnections).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  }
  expect(await setup.tunnel(bearer, 'registry.npmjs.org:443', clientHello(), afterEcho)).toBe(200);
  expect(setup.closeRecords).toHaveLength(1);
  expect(setup.closeRecords[0]).toMatchObject({ permitId: setup.permit,
    host: 'registry.npmjs.org', port: 443, address: '1.1.1.1',
    reason: expire ? 'expired' : 'revoked', bytesSent: clientHello().length,
    bytesReceived: clientHello().length });
  expect(setup.received().includes(bearer)).toBe(false);
  expect(setup.received().includes('secret-canary')).toBe(false);
}
it.each([false, true])('closes the real gateway and upstream within two seconds (expiry: %s)',
  closesRealTunnel);
