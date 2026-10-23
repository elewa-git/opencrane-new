import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadAuthConfig } from '@opencrane/auth';
import { demoStackId } from './demo-seed.ts';
import { demoBudget } from './demo-prepare.ts';
import { sanitiseEvidence } from './sanitise-evidence.mjs';

try {
  const id = demoStackId(process.env['DEV_STACK_ID']);
  const allowance = Number(process.env['DEMO_ALLOWANCE_CENTS']);
  if (!Number.isInteger(allowance) || allowance < 1 || allowance > 2000) {
    throw new Error('Invalid allowance');
  }
  const { authEnv, directory, readEnv, root } = await import('./config.ts');
  const marker = await readFile(`${directory}/stack-owner`, 'utf8');
  if (marker !== root && !marker.startsWith(`worktree=${root}\n`)) {
    throw new Error('Foreign stack');
  }
  const settings = await readEnv('settings');
  const origin = `http://127.0.0.1:${25000 + Number(id) * 100 + 6}`;
  if (settings['ORIGIN'] !== origin || settings['DEV_REAL_PROVIDER'] !== '1') {
    throw new Error('Unexpected stack');
  }
  const { browserSessions } = await import('./browser-signin.ts');
  const { demoRehearsal } = await import('./demo-rehearsal.ts');
  const browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const output = `${directory}/demo-rehearsal/${Date.now()}`;
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    const cookie = browser.sessions.get('owner')!.cookie;
    const options = { origin, directory, cookie };
    const extraSecrets = [cookie, cookie.slice(cookie.indexOf('=') + 1)];
    function sanitise(value: string) {
      return sanitiseEvidence(value, directory, root, extraSecrets);
    }
    try {
      const passed = await demoRehearsal(browser.ownerPage, browser.memberPages[0]!,
        options, output, allowance, sanitise);
      if (!passed) {
        process.exitCode = 1;
      }
    } finally {
      const budget = await demoBudget(options);
      const contents = JSON.stringify(budget, null, 2);
      await writeFile(`${output}/budget.json`, contents, { mode: 0o600 });
    }
  } finally {
    await browser.browser.close();
  }
} catch (error) {
  if (error instanceof Error &&
      error.message === 'Demo tasks require an explicit secondary id') {
    console.error(error.message);
  } else {
    console.error('Rehearsal incomplete; inspect private slot receipts. No turn is retried.');
  }
  process.exitCode = 1;
}
