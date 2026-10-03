import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('qualifies the chat frames and keyboard/stream/reload paths in Chromium', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/check-chat-browser.mjs'], { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 180_000 });
  expect(result.stdout).toContain('PASS Chromium');
}, 190_000);

it('serves the production chat under an enforcing script and style CSP', async () => {
  const result = await promisify(execFile)(process.execPath, ['scripts/check-chat-production.mjs'], { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 180_000 });
  expect(result.stdout).toContain('PASS production Chromium');
}, 190_000);
