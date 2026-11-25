import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Page, type Response, type Route } from 'playwright';
import { completeProviderSignIn } from '../dev-stack/browser-signin.ts';
import { verifyProvider } from './provider-settings.ts';

const origin = 'https://pilot-fixture.test';
const loginForm = `
  <form>
    <label>Login name<input name="loginName" required></label>
    <button>Continue</button>
  </form>
  <script>
    void fetch('/background');
    const form = document.querySelector('form');
    function submitCredentials(event) {
      event.preventDefault();
      if (form.elements.loginName?.value === 'pilot-member') {
        form.innerHTML = '<label>Password<input type="password" required></label>'
          + '<button>Continue</button>';
      } else if (form.querySelector('input[type=password]')?.value === 'fixture-password') {
        location.assign('/workspace');
      }
    }
    form.addEventListener('submit', submitCredentials);
  </script>`;

async function serveSignIn(route: Route): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  if (path === '/background') return;
  const body = path === '/auth/login' ? loginForm : '<h1>Member workspace</h1>';
  await route.fulfill({ contentType: 'text/html', body });
}

async function signInWithOpenRequest(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(3000);
    await page.route(`${origin}/**`, serveSignIn);
    const background = page.waitForRequest(`${origin}/background`);
    await page.goto(`${origin}/auth/login`);
    await background;
    await completeProviderSignIn(page, 'pilot-member', 'fixture-password', origin);
    const heading = page.getByRole('heading', { name: 'Member workspace', exact: true });
    await heading.waitFor();
  } finally {
    await browser.close();
  }
}

test('the mobile sign-in form completes with an unrelated request held open', signInWithOpenRequest);

async function readAfterVerification(): Promise<void> {
  const providerUrl = `${origin}/api/org/providers/fixture-provider`;
  const verificationUrl = `${providerUrl}/verify`;
  const readStarted = Promise.withResolvers<void>();
  const watchingResponse = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  let posted = false;
  let completed = false;
  let submissions = 0;
  let statusChecks = 0;

  async function clickVerification(): Promise<void> {
    submissions++;
    posted = true;
  }
  async function clickStatus(): Promise<void> {
    statusChecks++;
  }
  async function isVisible(): Promise<boolean> {
    return true;
  }
  function verificationMethod(): string {
    return 'POST';
  }
  function verificationRequest() {
    return { method: verificationMethod };
  }
  function verificationAddress(): string {
    return verificationUrl;
  }
  async function waitForResponse(matches: (response: Response) => boolean): Promise<Response> {
    watchingResponse.resolve();
    await reply.promise;
    assert(posted, 'The verification button sent a POST');
    const response = { request: verificationRequest, url: verificationAddress,
      status: successStatus } as unknown as Response;
    assert(matches(response), 'The driver observes the selected provider verification');
    completed = true;
    return response;
  }
  function successStatus(): number {
    return 200;
  }
  async function verifyGet(url: string) {
    assert.equal(url, providerUrl);
    const status = completed ? 200 : 503;
    readStarted.resolve();
    function httpStatus(): number {
      return status;
    }
    async function json() {
      return { rows: [{ reachable: { outcome: 'pass' } }] };
    }
    return { status: httpStatus, json };
  }
  function button(role: string, options: { name: string }) {
    assert.equal(role, 'button');
    if (options.name === 'Check status') return { click: clickStatus, isVisible };
    assert.equal(options.name, 'Check provider reachability');
    return { click: clickVerification };
  }
  function dialog(role: string, options: { name: string }) {
    assert.equal(role, 'dialog');
    assert.equal(options.name, 'Connect a provider');
    return { getByRole: button };
  }
  const page = { getByRole: dialog, waitForResponse, request: { get: verifyGet } } as unknown as Page;
  const verification = verifyProvider(page, providerUrl, 'Check provider reachability', 'pass');
  await Promise.race([readStarted.promise, watchingResponse.promise]);
  reply.resolve();
  await verification;
  assert.equal(submissions, 1);
  assert.equal(statusChecks, 1);
}

test('the provider status read starts after verification responds', readAfterVerification);

const providerOrigin = 'https://identity-fixture.test';
const foreignOrigin = 'https://foreign-fixture.test';
const foreignForm = `<form onsubmit="return false">
  <input name="loginName"><input type="password"><button>Continue</button>
</form>`;

async function foreignPage(route: Route): Promise<void> {
  await route.fulfill({ contentType: 'text/html', body: foreignForm });
}

async function redirectAfterLoginName(route: Route): Promise<void> {
  const body = `<form>
    <input name="loginName" required><button>Continue</button>
  </form><script>
    document.querySelector('form').onsubmit = function () {
      location.assign('${foreignOrigin}/password');
      return false;
    };
  </script>`;
  await route.fulfill({ contentType: 'text/html', body });
}

async function blocksForeignForm(startOnProvider: boolean): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.route(`${foreignOrigin}/**`, foreignPage);
    await page.route(`${providerOrigin}/**`, redirectAfterLoginName);
    const startingOrigin = startOnProvider ? providerOrigin : foreignOrigin;
    await page.goto(`${startingOrigin}/login`);
    const signIn = completeProviderSignIn(
      page, 'pilot-member', 'fixture-password', origin, providerOrigin,
    );
    const [outcome] = await Promise.allSettled([signIn]);
    const login = page.locator('input[name=loginName]');
    const password = page.locator('input[type=password]');
    assert.equal(await login.inputValue(), '');
    assert.equal(await password.inputValue(), '');
    assert.equal(outcome.status, 'rejected');
    assert.match(String(outcome.reason), /identity provider origin/u);
  } finally {
    await browser.close();
  }
}

test('a foreign login form receives neither credential', blocksForeignLoginName);
test('a foreign password form stays empty after the provider redirects', blocksForeignPassword);

function blocksForeignLoginName(): Promise<void> {
  return blocksForeignForm(false);
}

function blocksForeignPassword(): Promise<void> {
  return blocksForeignForm(true);
}
