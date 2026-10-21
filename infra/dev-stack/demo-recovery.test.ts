import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { prepareDemo } from './demo-prepare.ts';
import { spendingRecording } from './test/demo-spending-recording.ts';
import { demoRecording } from './test/demo-recording.ts';

async function restoresFailedPreparation() {
  const fixture = await demoRecording();
  fixture.budget.dailyCeilingCents = 100;
  const output = `${fixture.options.directory}/demo-smoke/run-one`;
  try {
    await assert.rejects(prepareDemo(fixture.options, 700, output), /Personal assistant required/u);
    assert.equal(fixture.budget.ceilingCents, 100);
    assert.equal(fixture.budget.dailyCeilingCents, 100);
    assert.deepEqual(fixture.writes.map(ceiling), [700, 100]);
    await assert.rejects(readFile(`${output}/saved-ceilings.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
function ceiling(command: Record<string, unknown>) { return command['ceilingCents']; }
test('preparation restores 100-cent ceilings after raising to 700 then receiving HTTP 503',
  restoresFailedPreparation);

async function interruptedLimit(signal: NodeJS.Signals) {
  const { spawn } = await import('node:child_process');
  const fixture = await demoRecording();
  fixture.allowPreparation();
  const output = `${fixture.options.directory}/demo-smoke/interrupted`;
  const env = { ...process.env, DEMO_OPTIONS: JSON.stringify(fixture.options),
    DEMO_OUTPUT: output, DEMO_INTERRUPT: '1' };
  const child = spawn(process.execPath,
    ['--experimental-strip-types', 'infra/dev-stack/test/demo-run-child.ts'],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let reachedLimit = false;
  let stderr = '';
  function errorOutput(bytes: Buffer) { stderr += bytes.toString(); }
  child.stderr!.on('data', errorOutput);
  async function interrupt(message: unknown) {
    if (message !== 'limit') return;
    reachedLimit = true;
    const saved = JSON.parse(await readFile(`${output}/saved-ceilings.json`, 'utf8'));
    assert.equal(saved.ceilingCents, 100);
    assert.equal(saved.dailyCeilingCents, 80);
    assert.equal(fixture.budget.ceilingCents, 700);
    assert.equal(fixture.budget.dailyCeilingCents, 0);
    child.kill(signal);
  }
  child.on('message', interrupt);
  function killChildAfterTimeout() { child.kill('SIGKILL'); }
  const timer = setTimeout(killChildAfterTimeout, 15000);
  try {
    const [code, killed] = await once(child, 'exit');
    assert.equal(reachedLimit, true, stderr);
    assert.equal(killed, null);
    assert.equal(code, 1);
    const spending = JSON.parse(await readFile(`${output}/spending.json`, 'utf8'));
    assert.equal(spending.callCount, 3);
    assert.equal(spending.chargedCents, 4);
    assert.equal(spending.heldCents, 25);
    const timings = JSON.parse(await readFile(`${output}/timings.json`, 'utf8'));
    assert.equal(timings.warmResult, 'PASS');
    assert.equal(timings.attempts.length, 1);
    assert.equal(timings.attempts[0].result, 'FAIL');
    assert.equal(fixture.budget.ceilingCents, 100);
    assert.equal(fixture.budget.dailyCeilingCents, 80);
    await assert.rejects(readFile(`${output}/saved-ceilings.json`), { code: 'ENOENT' });
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await fixture.close();
  }
}
async function interruptTerm() { await interruptedLimit('SIGTERM'); }
async function interruptInt() { await interruptedLimit('SIGINT'); }
test('SIGTERM during the limit step restores both original company ceilings', interruptTerm);
test('SIGINT during the limit step restores both original company ceilings', interruptInt);

async function recoversLeftover() {
  const runner = await import('./demo-smoke-run.ts');
  const { browserRecording } = await import('./test/demo-browser-recording.ts');
  const fixture = await demoRecording();
  const first = `${fixture.options.directory}/demo-smoke/first`;
  const second = `${fixture.options.directory}/demo-smoke/second`;
  try {
    fixture.failRestore(true);
    await assert.rejects(prepareDemo(fixture.options, 700, first));
    assert.equal(fixture.budget.ceilingCents, 700);
    const saved = JSON.parse(await readFile(`${first}/saved-ceilings.json`, 'utf8'));
    assert.equal(saved.ceilingCents, 100);
    assert.equal(saved.dailyCeilingCents, 80);
    fixture.failRestore(false);
    const previousWrites = fixture.writes.length;
    const browser = browserRecording();
    await assert.rejects(runner.runDemoSmoke(browser, fixture.options,
      700, second, 'fixture-sha', spendingRecording(browser.callCount), 'fixture'));
    assert.equal(fixture.writes[previousWrites]?.['ceilingCents'], 100);
    assert.equal(fixture.writes[previousWrites]?.['dailyCeilingCents'], 80);
    assert.equal(fixture.budget.ceilingCents, 100);
    assert.equal(fixture.budget.dailyCeilingCents, 80);
    await assert.rejects(readFile(`${first}/saved-ceilings.json`), { code: 'ENOENT' });
    await assert.rejects(readFile(`${second}/saved-ceilings.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
test('the next run restores a saved ceiling file before preparing another demo', recoversLeftover);
