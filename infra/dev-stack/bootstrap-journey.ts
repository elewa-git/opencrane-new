/// <reference lib="dom" />
// Fresh secondary qualification only. Always tears down its claimed stack.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { chromium, type Page } from 'playwright';
import { decodeSession, loadAuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { history } from '@opencrane/models';
import { enterLoginName, testUsers } from './browser-signin.ts';
import { browserChatJourney } from './browser-chat.ts';
import { authEnv, directory, readEnv, root } from './config.ts';
import { namespace, project, secondary, stackId } from './identity.ts';

assert(secondary, 'Bootstrap qualification requires a claimed secondary stack');
assert.equal(await readFile(`${directory}/stack-owner`, 'utf8'), root);
const exec = promisify(execFile);
const output = 'docs/process/bootstrap-live';
const tokenFile = `${directory}/bootstrap-token.json`;
await mkdir(output, { recursive: true });
let stage = 'installation';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let events: Awaited<ReturnType<typeof connectEventStore>> | undefined;
let pool: Pool | undefined;

async function capture(page: Page, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function signIn(page: Page, role: 'owner' | 'member', origin: string) {
  const user = (await testUsers())[role];
  await page.goto(`${origin}/claim`);
  await page.getByRole('link', { name: 'Sign in to claim', exact: true }).click();
  await page.locator('input[name=loginName]').waitFor();
  await page.waitForLoadState('networkidle');
  await enterLoginName(page, user.login);
  await page.locator('input[type=password]').fill(await readFile(user.passwordFile, 'utf8'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL(`${origin}/claim`);
  await page.getByLabel('Bootstrap token').waitFor();
  const config = loadAuthConfig(await authEnv());
  const cookie = (await page.context().cookies(origin)).find(item => item.name === config.cookieName);
  assert(cookie, 'Real Zitadel login issues a session');
  const session = decodeSession(config, cookie.value);
  assert.equal(session.sub, user.id);
  assert.equal(session.orgId, config.expectedOrgId);
  console.log(`PASS real secondary CI ${role} sign-in through Zitadel at 1280px`);
}

async function claim(page: Page, origin: string, token: string) {
  await page.getByLabel('Display name').fill('Bootstrap CI owner');
  await page.getByLabel('Contact email').fill('bootstrap-ci@example.test');
  await page.getByLabel('Bootstrap token').fill(token);
  const response = page.waitForResponse(reply => reply.url() === `${origin}/api/silo/claim`);
  await page.getByRole('button', { name: 'Claim this silo', exact: true }).press('Enter');
  const reply = await response;
  const body = await reply.json() as { status: string; reason?: string; memberId?: string };
  assert(!(await page.locator('body').innerText()).includes(token), 'Token is absent from rendered text');
  return { code: reply.status(), ...body };
}

try {
  const settings = await readEnv('settings');
  const origin = settings['ORIGIN']!, silo = settings['SILO_ID']!;
  const config = loadAuthConfig(await authEnv());
  events = await connectEventStore(await readEnv('command'));
  assert.equal((await history(events.store, 'member-*', silo)).length, 0, 'Fresh silo has no dev owner or members');
  // Keep the install command's only token output in memory; redact the evidence.
  const installed = await exec('npm', ['run', 'bootstrap-token', '-w', 'apps/server'], {
    cwd: root, env: { ...process.env, SILO_ID: silo, BOOTSTRAP_TOKEN_FILE: tokenFile },
  });
  const token = installed.stdout.trim().split('\n').at(-1)!;
  assert(/^[A-Za-z0-9_-]{43}$/u.test(token), 'Install prints one 256-bit token');
  const record = await readFile(tokenFile, 'utf8');
  assert(!record.includes(token), 'Private file holds only the hash');
  console.log('PASS npm run bootstrap-token -w apps/server; install output: [REDACTED]');
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ownerContext.newPage();
  page.setDefaultTimeout(90_000);
  stage = 'owner sign-in';
  await page.goto(`${origin}/claim`);
  await page.getByRole('heading', { name: 'Claim this silo' }).waitFor();
  await capture(page, 'signin');
  await signIn(page, 'owner', origin);
  await capture(page, 'claim');
  stage = 'owner claim';
  const claimed = await claim(page, origin, token);
  assert.equal(claimed.code, 201);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.memberId, 'bootstrap-owner');
  await page.getByRole('heading', { name: 'You are the silo owner' }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await capture(page, 'claimed');
  stage = 'owner permission convergence';
  const binding = await readEnv('binding');
  const authz = memberAuthorisation({ silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!, authorizationModelId: binding['OPENFGA_MODEL_ID']! });
  pool = new Pool({ connectionString: (await readEnv('projection'))['DATABASE_URL']! });
  const owner = (await testUsers()).owner;
  for (let attempt = 0; ; attempt++) {
    const rows = await pool.query<{ member_id: string; role: string; status: string }>(
      'SELECT m.member_id, m.role, m.status FROM member_identities i JOIN members m USING (silo, member_id) WHERE i.silo = $1 AND i.issuer = $2 AND i.sub = $3', [silo, config.issuerUrl, owner.id]);
    if (rows.rows[0]?.member_id === 'bootstrap-owner' && rows.rows[0].role === 'owner' && rows.rows[0].status === 'joined' && (await authz.check('bootstrap-owner', 'owner')).allowed) break;
    assert(attempt < 180, 'Owner projection and OpenFGA converge');
    await delay(500);
  }
  console.log('PASS claimant is the sole joined owner, bound to the real CI subject; OpenFGA owner=true');
  stage = 'stub chat';
  await browserChatJourney(page, origin);
  await capture(page, 'stub-chat');
  const images = await exec('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Image}} {{.ID}}']);
  const pods = JSON.parse((await exec('kubectl', ['--context=k3d-ocn', '-n', namespace, 'get', 'pods', '-o', 'json'])).stdout) as {
    items: Array<{ status: { containerStatuses?: Array<{ name: string; image: string; imageID: string }> } }>;
  };
  await writeFile(`${output}/images.json`, JSON.stringify({ source: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    compose: images.stdout.trim().split('\n'), computers: pods.items.flatMap(pod => pod.status.containerStatuses ?? [])
      .map(({ name, image, imageID }) => ({ name, image, imageID })) }, null, 2) + '\n');
  stage = 'token reuse';
  await page.goto(`${origin}/claim`);
  assert.deepEqual(await claim(page, origin, token), { code: 409, status: 'refused', reason: 'token_used' });
  await page.getByText('This token has already been used.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Bootstrap token').inputValue(), '');
  await capture(page, 'token-used');
  console.log('PASS same installation token refused a second time with token_used');
  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(90_000);
  stage = 'second user after owner';
  await signIn(memberPage, 'member', origin);
  assert.deepEqual(await claim(memberPage, origin, token), { code: 409, status: 'refused', reason: 'owner_exists' });
  await capture(memberPage, 'owner-exists');
  const memberHistory = await history(events.store, 'member-*', silo);
  assert.equal(memberHistory.length, 1);
  assert.equal(memberHistory[0]!.event.type, 'silo.owner_bootstrapped');
  assert.equal(memberHistory[0]!.event.principal?.id, owner.id);
  console.log('PASS second user refused with owner_exists after the owner claim; exactly one membership event');
  for (const name of ['server', 'web', 'members', 'dispatcher']) assert(!(await readFile(`${directory}/${name}.log`, 'utf8')).includes(token), 'Stack logs contain no bootstrap token');
  await pool.end(); pool = undefined;
  await events.close(); events = undefined;
  await browser.close(); browser = undefined;

  // members_exist requires membership history without an owner. Use another fresh
  // installation on the same claimed secondary slot, retaining only the token hash.
  stage = 'fresh membership refusal fixture';
  await exec('infra/dev-stack/up.sh', ['--id', stackId, '--fresh'], {
    cwd: root, env: { ...process.env, DEV_OWNER_BOOTSTRAP: '0' }, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  });
  await writeFile(tokenFile, record, { mode: 0o600 });
  events = await connectEventStore(await readEnv('command'));
  assert.equal((await history(events.store, 'member-*', silo)).length, 0);
  const member = (await testUsers()).member;
  const id = randomUUID();
  const parsed = parseEventByType({ id, commandId: id, type: 'member.invited', subject: 'member-existing-ci', silo,
    source: 'dev-stack-bootstrap-qualification', time: new Date().toISOString(), principal: { kind: 'system', id: 'qualification' },
    data: { ...getEventDefinition('member.invited')!.example as Record<string, unknown>, memberId: 'existing-ci', role: 'member', invitationId: id,
      invitedIdentity: { issuer: config.issuerUrl, sub: member.id }, expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
  assert(parsed.success);
  assert.equal((await events.store.append({ event: parsed.event, expectedSequence: 0 })).status, 'appended');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const secondPage = await context.newPage();
  stage = 'members_exist refusal';
  await signIn(secondPage, 'member', origin);
  const joined = await secondPage.request.post(`${origin}/members/join`, { headers: { origin },
    data: { memberId: 'existing-ci', invitationId: id, commandId: randomUUID(), displayName: 'Existing CI member' } });
  assert.equal(joined.status(), 200, 'Second user joins as an ordinary member through the shipped command');
  assert.deepEqual(await claim(secondPage, origin, token), { code: 409, status: 'refused', reason: 'members_exist' });
  await secondPage.getByText('This silo already has members. The installation token can only claim a fresh silo.', { exact: true }).waitFor();
  assert.equal(await secondPage.getByLabel('Bootstrap token').inputValue(), '');
  await capture(secondPage, 'members-exist');
  assert.deepEqual((await history(events.store, 'member-*', silo)).map(row => row.event.type), ['member.invited', 'member.joined'], 'Refusal appends no ownership event');
  console.log('PASS second CI user refused with members_exist in a fresh silo with a joined non-owner member; no ownership event');
} catch (error) {
  await writeFile('/tmp/bootstrap-final-live-failure.log', String(error), { mode: 0o600 });
  throw new Error(`Bootstrap live qualification failed at ${stage}; secret output suppressed`);
} finally {
  await browser?.close();
  await pool?.end();
  await events?.close();
  await exec('infra/dev-stack/down.sh', ['--id', stackId], { cwd: root, timeout: 600_000 });
  console.log(`PASS down.sh --id ${stackId}; secondary stack removed`);
}
