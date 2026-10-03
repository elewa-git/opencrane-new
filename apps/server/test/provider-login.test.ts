import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { enterLoginName } from '../../../infra/dev-stack/browser-signin.ts';

it('re-enters a login name cleared when the provider form becomes interactive', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="loginName"><button disabled>Continue</button><script>
      let first = true;
      const field = document.querySelector('input'), button = document.querySelector('button');
      field.addEventListener('input', () => {
        if (first) { first = false; field.value = ''; }
        button.disabled = field.value === '';
      });
      button.addEventListener('click', () => document.body.dataset.continued = field.value);
    </script>`);
    await enterLoginName(page, 'test-member');
    expect(await page.locator('body').getAttribute('data-continued')).toBe('test-member');
  } finally { await browser.close(); }
}, 20_000);
