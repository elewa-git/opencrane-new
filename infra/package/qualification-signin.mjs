import assert from 'node:assert/strict';
import { createServer as httpServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadAuthConfig } from '@opencrane/auth';
import { closeFixtureServers } from './tls-cleanup.mjs';
import { qualifyJoinedWorkspace } from './join-handoff.mjs';
import { assertMemberTokenRefusal, assertClaimRole } from './qualification-token.mjs';

const root = process.cwd();
const failureTools = await import(pathToFileURL(join(root,
  'infra/package/qualification-failure.mjs')));
const { captureJourneyFailure, closeAfterJourney } = failureTools;
const slot = process.env.DEV_STACK_ID;
assert(['1', '2'].includes(slot), 'Only a claimed secondary slot may run this journey');
const guard = await import(pathToFileURL(join(root, 'infra/dev-stack/journey-guard.ts')));
guard.requireAutomatedJourney();
const configuration = await import(pathToFileURL(join(root, 'infra/dev-stack/config.ts')));
const saved = await configuration.readEnv('settings');
guard.requireStandInJourney(saved);
guard.requireJourneyProviderMode(saved);
const authSettings = await configuration.authEnv();
const { cookieName } = loadAuthConfig({ ...authSettings, OIDC_COOKIE_SECURE: 'true' });
const signin = await import(pathToFileURL(join(root, 'infra/dev-stack/browser-signin.ts')));
const provider = await import(pathToFileURL(join(root, 'infra/dev-stack/zitadel-api.ts')));
const { chromium } = await import(pathToFileURL(join(root, 'node_modules/playwright/index.mjs')));
let inputBytes = '';
for await (const bytes of process.stdin) inputBytes += bytes.toString();
const input = JSON.parse(inputBytes);
const output = process.env.JOURNEY_RECEIPT_DIR;
const port = 25000 + Number(slot) * 100;
const applicationPort = port + 6;
const authenticationPort = port + 56;
const tlsPort = port + 54;
const proxyPort = port + 55;
const setup = JSON.parse(await readFile(join(configuration.directory, 'zitadel.json'), 'utf8'));
const outcomes = [];
const sockets = new Set();
let browser;
let stage = 'browser launch';
let failureCaptured = false;
let chatRequests = [];

async function retainFailure(error, context) {
  if (failureCaptured) return;
  failureCaptured = true;
  const page = context?.pages().at(-1);
  const failure = await captureJourneyFailure(page, error, { step: stage,
    path: join(output, `failed-${input.phase}.png`) });
  failure.chatRequests = chatRequests;
  outcomes.push(failure);
  console.log(`FAIL ${failure.step}; code=${failure.code}; screenshot=${failure.screenshot}`);
}

function record(name) {
  outcomes.push({ step: name, result: 'PASS' });
  console.log(`PASS ${name}`);
}

function trackSocket(socket) {
  if (sockets.has(socket)) return;
  sockets.add(socket);
  function closed() {
    sockets.delete(socket);
  }
  socket.once('close', closed);
}

function proxyRequest(incoming, response) {
  function received(upstream) {
    response.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(response);
  }
  function failed() {
    response.destroy();
  }
  const authentication = incoming.url === '/auth' || incoming.url.startsWith('/auth/');
  let targetPort = applicationPort;
  if (input.phase === 'wrong-org' && authentication) targetPort = authenticationPort;
  const upstream = request({ hostname: '127.0.0.1', port: targetPort,
    path: incoming.url, method: incoming.method, headers: incoming.headers }, received);
  upstream.on('error', failed);
  upstream.on('socket', trackSocket);
  incoming.pipe(upstream);
}

function websocket(incoming, socket, head) {
  const upstream = connect(applicationPort, '127.0.0.1');
  trackSocket(upstream);
  function connected() {
    const headers = [];
    for (const [name, value] of Object.entries(incoming.headers)) headers.push(`${name}: ${value}`);
    upstream.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }
  function failed() {
    socket.destroy();
  }
  upstream.on('connect', connected);
  upstream.on('error', failed);
  socket.on('error', failed);
}

function tunnel(incoming, socket, head) {
  const url = new URL(`https://${incoming.url}`);
  const local = url.hostname === input.host;
  const destination = local ? '127.0.0.1' : url.hostname;
  const destinationPort = local ? tlsPort : Number(url.port || '443');
  const upstream = connect(destinationPort, destination);
  trackSocket(upstream);
  function connected() {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  }
  function failed() {
    socket.destroy();
    upstream.destroy();
  }
  upstream.on('connect', connected);
  upstream.on('error', failed);
  socket.on('error', failed);
}

async function listen(server, port) {
  function listening(resolve, reject) {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }
  await new Promise(listening);
}

const tls = httpsServer({ key: await readFile(input.key),
  cert: await readFile(input.certificate) }, proxyRequest);
tls.on('upgrade', websocket);
tls.on('connection', trackSocket);
const proxy = httpServer();
proxy.on('connect', tunnel);
proxy.on('connection', trackSocket);

async function signIn(page, user, path = '/') {
  await page.goto(`${input.origin}${path}`);
  if (path === '/claim') {
    await page.getByRole('link', { name: 'Sign in to claim', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
  }
  const password = await readFile(user.passwordFile, 'utf8');
  await signin.completeProviderSignIn(page, user.login, password, input.origin, setup.issuer);
}

async function session(page, user) {
  const response = await page.request.get(`${input.origin}/auth/me`);
  assert.equal(response.status(), 200, 'Session check failed');
  const body = await response.json();
  assert.equal(body.authenticated, true, 'Real sign-in did not authenticate');
  assert.equal(body.user.sub, user.id, 'Another account signed in');
  const cookies = await page.context().cookies(input.origin);
  function sessionCookie(value) {
    return value.name === cookieName;
  }
  const cookie = cookies.find(sessionCookie);
  assert(cookie, 'Session cookie is absent');
  assert.equal(cookie.secure, true, 'Session cookie lacks Secure');
  assert.equal(cookie.httpOnly, true, 'Session cookie lacks HttpOnly');
}

async function submitClaim(page, token) {
  await page.getByLabel('Display name', { exact: true }).fill('Installation owner');
  await page.getByLabel('Contact email', { exact: true }).fill('installer@example.test');
  await page.getByLabel('Bootstrap token', { exact: true }).fill(token);
  function claimResponse(response) {
    return new URL(response.url()).pathname === '/api/silo/claim';
  }
  const pending = page.waitForResponse(claimResponse);
  await page.getByRole('button', { name: 'Claim this silo', exact: true }).click();
  const response = await pending;
  return { status: response.status(), body: await response.json() };
}

async function claimOwner(page) {
  const wrong = await submitClaim(page, 'a'.repeat(43));
  assert.equal(wrong.body.reason, 'wrong_token', 'An incorrect token was accepted');
  await page.getByText('That token is incorrect. Check it with the installer.').waitFor();
  assert.equal(await page.getByLabel('Bootstrap token').inputValue(), '', 'Token input was retained');
  record('wrong token refused without retaining the input');
  const claimed = await submitClaim(page, input.token);
  assert.equal(claimed.status, 201, 'The first owner claim failed');
  assert.equal(claimed.body.status, 'claimed', 'The owner was not recorded');
  await page.getByRole('heading', { name: 'You are the silo owner', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'owner-claimed-1280.png'), fullPage: true });
  record('one-time token creates the first owner');
  await page.goto(`${input.origin}/claim`);
  const reused = await submitClaim(page, input.token);
  assert.equal(reused.body.reason, 'token_used', 'A used token was accepted');
  await page.getByText('This token has already been used.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Bootstrap token').inputValue(), '', 'Token input was retained');
  await page.screenshot({ path: join(output, 'token-reuse-1280.png'), fullPage: true });
  record('used token refuses a second owner claim');
  return claimed.body.memberId;
}

async function invite(ownerPage, role, user) {
  const person = await provider.zitadelApi(`/management/v1/users/${user.id}`,
    '393311211338337681');
  const email = person.user.human.email.email;
  const memberId = randomUUID();
  const response = await ownerPage.request.post(`${input.origin}/api/invitations`, {
    headers: { origin: input.origin }, data: { commandId: randomUUID(), memberId,
      email, expectedSequence: 0, role, personalAssistant: 'provision' },
  });
  assert.equal(response.status(), 200, 'Invitation creation failed');
  const body = await response.json();
  assert.equal(body.status, 'appended', 'Invitation was not recorded');
  return { memberId, invitationId: body.invitationId, commandId: randomUUID(),
    displayName: `${role} traveller` };
}

async function chat(page, role, width) {
  chatRequests = [];
  function recordChatResponse(response) {
    if (response.request().method() !== 'POST') return;
    const path = new URL(response.url()).pathname;
    if (path === '/api/conversations') {
      chatRequests.push({ operation: 'create conversation', status: response.status() });
    } else if (/^\/api\/conversations\/[^/]+\/messages$/u.test(path)) {
      chatRequests.push({ operation: 'send message', status: response.status() });
    }
  }
  page.on('response', recordChatResponse);
  stage = `${role} ${width}px workspace`;
  const liveAssignments = [];
  function frameReceived(event) {
    const frame = JSON.parse(String(event.payload));
    if (frame.type === 'context' && frame.topic === 'chat-context') {
      liveAssignments.push({ time: new Date().toISOString(), assigned: Boolean(frame.data.assistantId) });
    }
  }
  function socketOpened(socket) {
    socket.on('framereceived', frameReceived);
  }
  function contextResponse(response) {
    return new URL(response.url()).pathname === '/api/chat';
  }
  page.on('websocket', socketOpened);
  const firstContext = page.waitForResponse(contextResponse);
  await page.goto(`${input.origin}/workspace`);
  const initialResponse = await firstContext;
  assert.equal(initialResponse.status(), 200, 'Initial workspace context read failed');
  const initial = await initialResponse.json();
  assert.equal(initial.role, role, 'Another role reached the workspace');
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  stage = `${role} ${width}px composer`;
  await composer.waitFor({ timeout: 60_000 });
  if (!initial.assistantId) {
    function assigned(value) { return value.assigned; }
    assert(liveAssignments.some(assigned), 'The initially unassigned workspace received no live assignment');
    record(`${role} ${width}px initial workspace receives its assignment without reload`);
  }
  await writeFile(join(output, `${role}-assignment-${width}.json`), JSON.stringify({
    initiallyAssigned: Boolean(initial.assistantId), liveAssignments,
  }));
  function skeletonGone() {
    return !document.querySelector('.skeleton');
  }
  await page.waitForFunction(skeletonGone);
  stage = `${role} ${width}px draft`;
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  stage = `${role} ${width}px send`;
  await composer.fill('Say hello briefly.');
  await composer.press('Enter');
  stage = `${role} ${width}px reply`;
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true });
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor({ timeout: 120_000 });
  stage = `${role} ${width}px completion`;
  await reply.getByText('Done', { exact: true }).waitFor();
  stage = `${role} ${width}px screenshot`;
  await page.screenshot({ path: join(output, `${role}-chat-${width}.png`), fullPage: true });
  record(`${role} real sign-in and packaged stand-in-model chat at ${width}px`);
}

async function newContext(width) {
  return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 } });
}

async function joinedAccess(memberId) {
  function waitForReady(resolve) {
    process.once('message', resolve);
  }
  const ready = new Promise(waitForReady);
  process.send({ operation: 'joined-access', memberId });
  const result = await ready;
  assert.equal(result.operation, 'joined-access');
  assert.equal(result.memberId, memberId);
  assert.equal(result.status, 'ready', 'Joined access preparation failed');
  record('joined member access is applied before the first protected read');
}

async function visitProduct(ownerContext) {
  const ownerPage = await ownerContext.newPage();
  stage = 'owner 1280px sign-in';
  await signIn(ownerPage, setup.users.owner, '/claim');
  stage = 'owner 1280px session';
  await session(ownerPage, setup.users.owner);
  record('owner Secure and HttpOnly session at 1280px');
  stage = 'owner 1280px claim';
  const ownerMemberId = await claimOwner(ownerPage);
  stage = 'owner 1280px workspace';
  await chat(ownerPage, 'owner', 1280);
  const ownerPhone = await newContext(390);
  async function visitOwnerPhone() {
    const page = await ownerPhone.newPage();
    stage = 'owner 390px sign-in';
    await signIn(page, setup.users.owner);
    stage = 'owner 390px session';
    await session(page, setup.users.owner);
    record('owner Secure and HttpOnly session at 390px');
    stage = 'owner 390px workspace';
    await chat(page, 'owner', 390);
  }
  await closeAfterJourney(ownerPhone, visitOwnerPhone, retainFailure);
  stage = 'owner 1280px directory';
  await ownerPage.goto(`${input.origin}/org/people`);
  await ownerPage.getByRole('button', { name: 'Invite people', exact: true }).waitFor();
  for (const role of ['admin', 'member']) {
    const user = role === 'admin' ? setup.users['without-assistant'] : setup.users.member;
    stage = `${role} 1280px invitation`;
    const invitation = await invite(ownerPage, role, user);
    for (const width of [1280, 390]) {
      const context = await newContext(width);
      async function visitRole() {
        const page = await context.newPage();
        stage = `${role} ${width}px sign-in`;
        await signIn(page, user);
        stage = `${role} ${width}px session`;
        await session(page, user);
        record(`${role} Secure and HttpOnly session at ${width}px`);
        async function join() {
          const response = await page.request.post(`${input.origin}/members/join`, {
            headers: { origin: input.origin }, data: invitation,
          });
          assert.equal(response.status(), 200, 'Invitation acceptance failed');
          assert.equal((await response.json()).status, 'joined', 'The member did not join');
        }
        const accessReady = joinedAccess.bind(null, invitation.memberId);
        const openWorkspace = chat.bind(null, page, role, width);
        stage = `${role} ${width}px workspace`;
        if (width === 1280) await qualifyJoinedWorkspace(join, accessReady, openWorkspace);
        else await openWorkspace();
        if (role === 'member' && width === 390) {
          stage = 'member 390px token reuse';
          const response = await page.request.post(`${input.origin}/api/silo/claim`, {
            headers: { origin: input.origin }, data: { token: input.token,
              displayName: 'Member traveller', email: 'member@example.test' },
          });
          assertMemberTokenRefusal(response.status(), await response.json());
          const expectedMember = { memberId: invitation.memberId, role: 'member' };
          const expectedOwner = { memberId: ownerMemberId, role: 'owner' };
          await assertClaimRole(page, input.origin, expectedMember);
          await assertClaimRole(ownerPage, input.origin, expectedOwner);
          record('member cannot reuse the installation token to become owner');
        }
      }
      await closeAfterJourney(context, visitRole, retainFailure);
    }
  }
}

async function product() {
  const ownerContext = await newContext(1280);
  const visit = visitProduct.bind(null, ownerContext);
  await closeAfterJourney(ownerContext, visit, retainFailure);
}

async function wrongOrganisation() {
  for (const width of [1280, 390]) {
    stage = `wrong-organisation ${width}px sign-in`;
    const context = await newContext(width);
    async function visitWrongOrganisation() {
      const page = await context.newPage();
      await signIn(page, setup.users.owner);
      assert.equal(new URL(page.url()).searchParams.get('reason'), 'organisation');
      await page.getByText(/^Your account isn't part of/).waitFor();
      const response = await page.request.get(`${input.origin}/auth/me`);
      assert.equal((await response.json()).authenticated, false, 'Another organisation gained a session');
      const cookies = await context.cookies(input.origin);
      function isSession(value) {
        return value.name === cookieName;
      }
      const sessionCookie = cookies.find(isSession);
      assert.equal(sessionCookie, undefined, 'A refused organisation received a session cookie');
      await page.screenshot({ path: join(output, `wrong-organisation-${width}.png`), fullPage: true });
      record(`real token from another organisation pin refused at ${width}px`);
    }
    await closeAfterJourney(context, visitWrongOrganisation, retainFailure);
  }
}

try {
  await listen(tls, tlsPort);
  await listen(proxy, proxyPort);
  browser = await chromium.launch({ headless: true, channel: 'chromium',
    proxy: { server: `http://127.0.0.1:${proxyPort}` } });
  if (input.phase === 'wrong-org') await wrongOrganisation();
  else await product();
} catch (error) {
  await retainFailure(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  const servers = [tls, proxy];
  closeFixtureServers(servers, sockets);
  await writeFile(join(output, `browser-${input.phase}.json`), JSON.stringify(outcomes),
    { mode: 0o600 });
}
