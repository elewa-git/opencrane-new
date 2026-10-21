import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { prepareDemo } from './demo-prepare.ts';
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
  const { once } = await import('node:events');
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
  const timer = setTimeout(function timeout() { child.kill('SIGKILL'); }, 15000);
  try {
    const [code, killed] = await once(child, 'exit');
    assert.equal(reachedLimit, true, stderr);
    assert.equal(killed, null);
    assert.equal(code, 1);
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
    await assert.rejects(runner.runDemoSmoke(browserRecording(), fixture.options,
      700, second, 'fixture-sha'));
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
