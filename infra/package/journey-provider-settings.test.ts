import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { checkProviderStatus, createProviderConnection, enterProviderKey,
  saveProviderKey } from './provider-settings.ts';

const fixture = `
<div class="page-actions"><button onclick="setup.showModal()">Connect a provider</button></div>
<button onclick="setup.showModal()">Connect a provider</button>
<dialog id="setup" aria-label="Connect a provider">
  <h3>Step 1 of 6 · Provider</h3>
  <label>Connection name Required<input id="name"></label>
  <footer><button onclick="recordName()">Next</button></footer>
</dialog>
<dialog aria-label="Replace the key for provider?">
  <label>API key Required<input id="replace-provider-key" type="password"></label>
</dialog>
<script>
function advanceAfterRendering() {
  requestAnimationFrame(showKey);
}
function recordName() {
  if (window.automaticAdvance) {
    document.querySelector('#setup footer').innerHTML = '<button disabled>Check status</button>';
    requestAnimationFrame(advanceAfterRendering);
    return;
  }
  document.querySelector('#setup footer').innerHTML =
    '<p>Provider name recorded. Its records are still applying. Check status.</p>' +
    '<button onclick="showKey()">Check status</button>';
}
function showKey() {
  document.querySelector('#setup').innerHTML =
    '<h3>Step 2 of 6 · Key</h3>' +
    '<label>API key Required<input id="provider-key" type="password"></label>' +
    '<footer><button onclick="recordKey()">Save key</button></footer>';
}
function recordKey() {
  document.querySelector('#setup footer').innerHTML =
    '<p>Key saved. Its provider record is still applying. Check status again.</p>' +
    '<button onclick="verify()">Check status</button>';
}
function verify() {
  document.querySelector('#setup').innerHTML = '<h3>Step 3 of 6 · Verify</h3>';
}
</script>`;

async function followsVisibleSetup(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(1000);
      await page.setContent(fixture);
      await createProviderConnection(page, 'Package free provider');
      await enterProviderKey(page, 'synthetic-fixture-key');
      const dialog = page.getByRole('dialog', { name: 'Connect a provider', exact: true });
      const field = dialog.getByLabel('API key Required', { exact: true });
      assert.equal(await field.count(), 1);
      assert.equal(await field.isVisible(), true);
      assert.equal(await field.inputValue(), 'synthetic-fixture-key');
      assert.equal(await page.locator('#replace-provider-key').inputValue(), '');
      await saveProviderKey(page, 'synthetic-fixture-key');
      await dialog.getByRole('heading', { name: 'Step 3 of 6 · Verify', exact: true }).waitFor();
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test('new-key setup follows Check status and ignores the closed replacement field at both widths',
  followsVisibleSetup);

async function followsAutomaticAdvance(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(1000);
      await page.setContent(fixture + '<script>window.automaticAdvance = true;</script>');
      await createProviderConnection(page, 'Package free provider');
      await enterProviderKey(page, 'synthetic-fixture-key');
      const dialog = page.getByRole('dialog', { name: 'Connect a provider', exact: true });
      assert.equal(await dialog.getByLabel('API key Required', { exact: true }).isVisible(), true);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test('new-key setup follows automatic advancement while Check status is disabled at both widths',
  followsAutomaticAdvance);

async function followsAdvanceDuringStatusClick(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const pendingControl = '<button onclick="showKey()">Check status</button>';
  const advancingControl = '<button style="margin-left:100px" ' +
    'onpointerover="showKey()" onclick="showKey()">Check status</button>';
  const advancingFixture = fixture.replace(pendingControl, advancingControl);
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(1000);
      await page.setContent(advancingFixture);
      await createProviderConnection(page, 'Package free provider');
      await enterProviderKey(page, 'synthetic-fixture-key');
      const setup = page.getByRole('dialog', { name: 'Connect a provider', exact: true });
      const key = setup.getByLabel('API key Required', { exact: true });
      assert.equal(await key.isVisible(), true);
      assert.equal(await key.inputValue(), 'synthetic-fixture-key');
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test('setup advances while the status click loses its button at both widths',
  followsAdvanceDuringStatusClick);

async function checksOnlyOpenSetup(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(`
        <section aria-label="Model providers">
          <button onclick="backgroundRead()">Check status</button>
          <p id="background-count">0</p>
        </section>
        <section role="dialog" aria-label="Connect a provider">
          <section aria-label="Provider verification facts">
            <button onclick="verificationRead()">Check status</button>
            <p id="verification-count">0</p>
          </section>
        </section>
        <script>
          function backgroundRead() {
            document.querySelector('#background-count').textContent = '1';
          }
          function verificationRead() {
            document.querySelector('#verification-count').textContent = '1';
          }
        </script>`);
      await checkProviderStatus(page);
      assert.equal(await page.locator('#verification-count').innerText(), '1');
      assert.equal(await page.locator('#background-count').innerText(), '0');
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test('verification checks the open setup when the background table also offers Check status',
  checksOnlyOpenSetup);
