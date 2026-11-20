import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createProviderConnection, enterProviderKey } from './provider-settings.ts';

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
function recordName() {
  document.querySelector('#setup footer').innerHTML =
    '<p>Provider name recorded. Its records are still applying. Check status.</p>' +
    '<button onclick="showKey()">Check status</button>';
}
function showKey() {
  document.querySelector('#setup').innerHTML =
    '<h3>Step 2 of 6 · Key</h3>' +
    '<label>API key Required<input id="provider-key" type="password"></label>';
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
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test('new-key setup follows Check status and ignores the closed replacement field at both widths',
  followsVisibleSetup);
