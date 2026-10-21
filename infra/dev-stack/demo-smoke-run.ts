import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { loadAuthConfig } from '@opencrane/auth';
import { demoStackId, seedDemo } from './demo-seed.ts';
import { prepareDemo, demoBudget } from './demo-prepare.ts';

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
  const { warmDemo, demoBrowser } = await import('./demo-browser.ts');
  const browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const output = `${directory}/demo-smoke/${Date.now()}`;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const options = { origin, directory, cookie: browser.sessions.get('owner')!.cookie };
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const attempts: Array<Awaited<ReturnType<typeof demoBrowser>> & { width: number }> = [];
  try {
    await seedDemo(options);
    await prepareDemo(options, allowance);
    const member = browser.memberPages[0]!;
    const warmStarted = performance.now();
    const sharedUrl = await warmDemo(browser.ownerPage, member, origin);
    const warmMs = Math.round(performance.now() - warmStarted);
    for (const width of [1280, 390]) {
      const ownerPage = await browser.ownerPage.context().newPage();
      const memberPage = await member.context().newPage();
      await ownerPage.setViewportSize({ width, height: 900 });
      const result = await demoBrowser(ownerPage, memberPage, options, sharedUrl, output, width);
      await ownerPage.close();
      await memberPage.close();
      attempts.push({ width, ...result });
      console.log(`${result.result} demo smoke ${width}px: ${result.elapsedMs} ms`);
    }
    await writeFile(`${output}/timings.json`, JSON.stringify({ sha, warmMs, attempts }, null, 2));
  } finally {
    const budget = await demoBudget(options);
    await writeFile(`${output}/spending.json`, JSON.stringify({ sha, budget }, null, 2));
    await browser.browser.close();
  }
  function failed(attempt: typeof attempts[number]) {
    return attempt.result !== 'PASS';
  }
  if (attempts.length !== 2 || attempts.some(failed)) process.exitCode = 1;
} catch {
  console.error('Demo smoke incomplete; inspect private slot receipts. No turn is retried.');
  process.exitCode = 1;
}
