import './journey-entry.ts';
// Run after up with fresh or repeat. Replaces only this secondary HTTP process with
// buildServer using the local HTTPS fixture transport; finish with down.sh --id.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { connectEventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import { connectMcpCatalogue, connectMemberFeed } from '@opencrane/projections';
import { buildServer } from '../../apps/server/src/server.ts';
import { attachWebSocketServer } from '../../apps/server/src/websocket.ts';
import { remoteReference } from '../../apps/server/src/integrations/registration.ts';
import { enterLoginName, testUsers } from './browser-signin.ts';
import { authEnv, directory, readEnv, root } from './config.ts';
import { secondary } from './identity.ts';

assert(secondary, 'MCP qualification requires a claimed secondary stack');
const run = process.argv[2];
assert(run === 'fresh' || run === 'repeat', 'Choose fresh or repeat evidence');
assert.equal(await readFile(`${directory}/stack-owner`, 'utf8'), root);
const settings = await readEnv('settings'), binding = await readEnv('binding');
const server = await readEnv('server'), config = loadAuthConfig(await authEnv());
assert.equal(config.expectedOrgId, '393311211338337681');
const origin = settings['ORIGIN']!, silo = settings['SILO_ID']!;
const [pidText, started] = (await readFile(`${directory}/server.pid`, 'utf8')).split(' ');
const pid = Number(pidText);
const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], started);
process.kill(-pid, 'SIGTERM');
for (let attempt = 0; ; attempt++) {
  const alive = await readFile(`/proc/${pid}/stat`, 'utf8').then(s => !s.includes(') Z '), () => false);
  if (!alive) break;
  assert(attempt < 150, 'Secondary HTTP process did not stop');
  await delay(100);
}
await rm(`${directory}/server.pid`);

const { remoteFixture } = await import('../../apps/server/test/support/remote-mcp.ts');
const remote = await remoteFixture();
const events = await connectEventStore(await readEnv('command'));
const feed = await connectMemberFeed(server['DATABASE_URL']!);
const catalogue = connectMcpCatalogue(server['DATABASE_URL']!);
const authBinding = { silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!, authorizationModelId: binding['OPENFGA_MODEL_ID']! };
const app = buildServer(config, {
  membership: { silo, store: events.store },
  integrations: { silo, store: events.store, feed, catalogue, binding: authBinding,
    discovery: { ...remote.network, resolve: async host => {
      assert.equal(host, 'mcp.example.test', 'Only the local fixture may be discovered');
      return remote.network.resolve!(host);
    } } },
});
const browser = await chromium.launch({ headless: true });
const sockets = attachWebSocketServer(app.server, app.log, config, { feed, binding: authBinding });
try {
  await app.listen({ host: '127.0.0.1', port: Number(server['PORT']) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert([origin, config.issuerUrl].includes(url.origin), `Unexpected browser destination: ${url.origin}`);
    await route.continue();
  });
  const page = await context.newPage();
  const owner = (await testUsers()).owner;
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
  await page.locator('input[name=loginName]').waitFor();
  await page.waitForLoadState('networkidle');
  await enterLoginName(page, owner.login);
  await page.locator('input[type=password]').fill(await readFile(owner.passwordFile, 'utf8'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(origin + '/');
  await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
  console.log('PASS owner signed in through Zitadel on the secondary stack');

  const output = `docs/process/p3-3-live/${run}`;
  await mkdir(output, { recursive: true });
  const capture = async (name: string) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate('document.fonts.ready');
      assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Page fits viewport');
      await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
    }
  };
  let registrations = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/org/integrations') registrations++;
  });
  await page.goto(`${origin}/org/integrations`);
  await page.getByRole('link', { name: 'Add MCP server', exact: true }).click();
  await page.getByLabel('Server URL', { exact: true }).fill('http://127.0.0.1/mcp');
  await page.getByRole('button', { name: 'Discover tools', exact: true }).click();
  await page.getByText('Enter an HTTPS address without credentials, a query or a fragment.', { exact: false }).waitFor();
  assert.equal(registrations, 0, 'HTTP rejection sends no registration');
  await capture('http-refused');
  console.log('PASS HTTP URL refused with an HTTPS explanation and no registration');

  await page.getByLabel('Server URL', { exact: true }).fill('https://192.168.1.1/mcp');
  const refused = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/org/integrations');
  await page.getByRole('button', { name: 'Discover tools', exact: true }).click();
  assert.equal((await refused).status(), 400);
  await page.getByText('Use a public HTTPS hostname; IP addresses, including private addresses, are not accepted. Nothing was registered.', { exact: false }).waitFor();
  assert.equal(remote.calls.length, 0, 'Refused addresses must not reach the fixture');
  await capture('private-refused');
  console.log('PASS private-address URL refused with a public-hostname explanation and no outbound request');

  const locator = `https://mcp.example.test/${run}`;
  const { serverId } = remoteReference(silo, locator);
  assert.equal((await history(events.store, `mcp-${serverId}`, silo)).length, 0, 'Fresh MCP stream');
  await page.getByLabel('Server URL', { exact: true }).fill(locator);
  const registered = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/org/integrations');
  await page.getByRole('button', { name: 'Discover tools', exact: true }).click();
  assert.equal((await registered).status(), 202);
  await page.reload();
  await page.getByText('Outcome unknown', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Check status', exact: true }).waitFor();
  await capture('reload');
  for (let attempt = 0; ; attempt++) {
    await page.getByRole('button', { name: 'Check status', exact: true }).click();
    await page.getByRole('button', { name: 'Check status', exact: true }).waitFor();
    if (await page.getByRole('region', { name: 'Tool inventory' }).isVisible()) break;
    assert(attempt < 50, 'Discovery did not finish');
    await delay(100);
  }
  await page.getByText('2 tools discovered · 0 allowed', { exact: true }).waitFor();
  assert.equal(await page.getByText('− Blocked · Unreviewed', { exact: true }).count(), 2);
  await page.getByText('Review definition and digest', { exact: true }).first().click();
  await capture('inventory');
  assert.equal(registrations, 2, 'Only the refused private address and accepted fixture were submitted');
  const rows = await history(events.store, `mcp-${serverId}`, silo);
  assert.deepEqual(rows.map(row => row.event.type), ['mcp.server_registered', 'mcp.server_discovered']);
  assert.deepEqual(remote.calls.map(call => call.method), ['server/discover', 'tools/list', 'tools/list']);
  assert.deepEqual(remote.pinned, Array(3).fill('93.184.216.34'));
  assert(remote.calls.every(call => call.hostname === 'mcp.example.test' && !call.headers.authorization));
  console.log('PASS local TLS discovery: two paginated tools, reviewable definitions/digests, zero allowed');
  console.log('PASS reload: Check status restores inventory; one registration event and no tool calls');
  console.log('PASS screenshots at 1280px and 390px; no horizontal overflow');
} finally {
  await browser.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await app.close();
  await Promise.all([feed.close(), catalogue.close(), events.close(), remote.close()]);
}
