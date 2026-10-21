import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectEventStore, type EventStore } from '@opencrane/event-store';
import { demoSpending } from './demo-spending.ts';
import { loadAuthConfig } from '@opencrane/auth';
import type { browserSessions } from './browser-signin.ts';
import { demoStackId, seedDemo } from './demo-seed.ts';
import { prepareDemo, demoBudget, recoverDemoCeilings,
  saveDemoCeilings, restoreDemoCeilings } from './demo-prepare.ts';

type Browser = Pick<Awaited<ReturnType<typeof browserSessions>>,
  'browser' | 'ownerPage' | 'memberPages'>;
type Options = Parameters<typeof demoBudget>[0];

export async function runDemoSmoke(browser: Browser, options: Options, allowance: number,
  output: string, sha: string, store: Pick<EventStore, 'head' | 'readStream'>, silo: string) {
  const { warmDemo, demoBrowser } = await import('./demo-browser.ts');
  const controller = new AbortController();
  const running = { ...options, signal: controller.signal };
  const attempts: Array<Awaited<ReturnType<typeof demoBrowser>> & { width: number }> = [];
  let closing: Promise<void> | undefined;
  let spending: Awaited<ReturnType<typeof demoSpending>> | undefined;
  let warmMs: number | null = null;
  let warmResult = 'NOT RUN';
  function interrupt() {
    controller.abort();
    closing ??= browser.browser.close();
    void closing.catch(ignoreClose);
  }
  function ignoreClose() {
    // Keep restoration running even if the browser has already stopped.
  }
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await recoverDemoCeilings(running);
    const contexts = [browser.ownerPage.context(), browser.memberPages[0]!.context()];
    spending = await demoSpending(options, output, sha, store, silo, contexts);
    await saveDemoCeilings(running, output);
    await seedDemo(running);
    await prepareDemo(running, allowance, output);
    const member = browser.memberPages[0]!;
    const warmStarted = performance.now();
    let sharedUrl: string;
    warmResult = 'FAIL';
    try {
      sharedUrl = await warmDemo(browser.ownerPage, member, options.origin);
      warmResult = 'PASS';
    } finally {
      warmMs = Math.round(performance.now() - warmStarted);
      await spending.save();
    }
    for (const width of [1280, 390]) {
      controller.signal.throwIfAborted();
      const ownerPage = await browser.ownerPage.context().newPage();
      const memberPage = await member.context().newPage();
      try {
        await ownerPage.setViewportSize({ width, height: 900 });
        const result = await demoBrowser(ownerPage, memberPage, running, sharedUrl, output, width);
        attempts.push({ width, ...result });
        await spending.save();
        console.log(`${result.result} demo smoke ${width}px: ${result.elapsedMs} ms`);
      } finally {
        await ownerPage.close();
        await memberPage.close();
      }
    }
    controller.signal.throwIfAborted();
    function failed(attempt: typeof attempts[number]) { return attempt.result !== 'PASS'; }
    if (attempts.length !== 2 || attempts.some(failed)) throw new Error('Demo smoke failed');
  } finally {
    try {
      // Wait for the active operation to end before restoring, so it cannot raise limits later.
      await restoreDemoCeilings(options, output);
    } finally {
      try {
        const timings = { sha, warmMs, warmResult, attempts };
        try {
          await writeFile(`${output}/timings.json`, JSON.stringify(timings, null, 2), { mode: 0o600 });
        } finally {
          await spending?.save();
        }
      } finally {
        try {
          closing ??= browser.browser.close();
          await closing;
        } finally {
          spending?.stop();
          process.off('SIGINT', interrupt);
          process.off('SIGTERM', interrupt);
        }
      }
    }
  }
}

async function main() {
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
  const browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const output = `${directory}/demo-smoke/${Date.now()}`;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const options = { origin, directory, cookie: browser.sessions.get('owner')!.cookie };
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  try {
    const events = await connectEventStore(await readEnv('command'));
    try {
      await runDemoSmoke(browser, options, allowance, output, sha, events.store, settings['SILO_ID']!);
    } finally {
      await events.close();
    }
  } finally {
    await browser.browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error('Demo smoke incomplete; inspect private slot receipts. No turn is retried.');
    process.exitCode = 1;
  }
}
