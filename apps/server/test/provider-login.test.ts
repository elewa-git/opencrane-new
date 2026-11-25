import { chromium, type Route } from 'playwright';
import { expect, it } from 'vitest';
import { enterLoginName } from '../../../infra/dev-stack/browser-signin.ts';

const issuer = 'https://idp.example.test';

it('re-enters a login name cleared when the provider form becomes interactive',
  retriesNameClearedByHydration, 20_000);

async function retriesNameClearedByHydration() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const form = `<input name="loginName"><button disabled>Continue</button><script>
      let first = true;
      const field = document.querySelector('input'), button = document.querySelector('button');
      field.addEventListener('input', () => {
        if (first) { first = false; field.value = ''; }
        button.disabled = field.value === '';
      });
      button.addEventListener('click', () => document.body.dataset.continued = field.value);
    </script>`;
    async function showProvider(route: Route) {
      await route.fulfill({ contentType: 'text/html', body: form });
    }
    await page.route(`${issuer}/**`, showProvider);
    await page.goto(issuer);
    await enterLoginName(page, 'test-member', issuer);
    expect(await page.locator('body').getAttribute('data-continued')).toBe('test-member');
  } finally {
    await browser.close();
  }
}
