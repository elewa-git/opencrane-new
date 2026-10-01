// Run after the clean suites, without any other test process in this folder.
// Each deliberate break must fail its behaviour assertion, not merely setup.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (existsSync('.state') && readdirSync('.state').length) throw Error('Stop other spike tests first');
const cases = [
  {
    name: 'integer-money', file: 'src/money.ts',
    from: "  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected non-negative integer euro cents');",
    to: '  void value; // MUTATION: accept fractional money',
    test: 'tests/scenario-checkers.test.ts', match: 'rejects fractions',
    failure: 'AssertionError',
  },
  {
    name: 'budget-limit', file: 'src/temporal-workflows/workflows.ts',
    from: 'if (reservedCents + req.amountCents > input.ceilingCents)',
    to: 'if (false)',
    test: 'tests/temporal/05-budget-actor.test.ts', match: 'memory only',
    failure: 'exactly the requests that fit under the ceilingCents are accepted',
  },
  {
    name: 'ordering', file: 'src/temporal-workflows/workflows.ts',
    from: '      await run({', to: '      void run({',
    test: 'tests/temporal/01-ordering-parallelism.test.ts', match: 'runs 100 keys',
    failure: 'every rule in the delivery contract must hold',
  },
  {
    name: 'retries', file: 'src/temporal-workflows/workflows.ts',
    from: "initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '4s', maximumAttempts: 4",
    to: "initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '4s', maximumAttempts: 1",
    test: 'tests/temporal/02-retry-poison.test.ts', match: 'good keys flow',
    failure: 'poison event must still be retrying',
  },
  {
    name: 'retry-backoff', file: 'src/temporal-workflows/workflows.ts',
    from: "initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '4s', maximumAttempts: 4",
    to: "initialInterval: '1s', backoffCoefficient: 1, maximumInterval: '4s', maximumAttempts: 4",
    test: 'tests/temporal/02-retry-poison.test.ts', match: 'good keys flow',
    failure: 'last gap must be several times the first',
  },
  {
    name: 'poison-hold', file: 'src/temporal-workflows/workflows.ts',
    from: '      state.deadLetter = { eventId: ev.eventId, seq: ev.seq, message };',
    to: '      state.queue.shift(); // MUTATION: silently skip the failed head',
    test: 'tests/temporal/02-retry-poison.test.ts', match: 'good keys flow',
    failure: 'waitUntil: condition not met',
  },
  {
    name: 'attempt-logs', file: 'src/temporal-workflows/activities.ts',
    from: '  attemptLog.push({ key: input.key, seq: input.seq, attempt, at: start, failed: fail });',
    to: '  // MUTATION: dropped attempt logs',
    test: 'tests/temporal/04-visibility.test.ts', match: 'shows attempts',
    failure: 'AssertionError',
  },
];
const only = process.env.S08_MUTATION_ONLY;
const summary = only ? readFileSync('evidence/mutation-summary.txt', 'utf8').trim().split('\n').filter(Boolean) : [];
for (const c of cases.filter((item) => !only || item.name === only)) {
  const original = readFileSync(c.file, 'utf8');
  if (!original.includes(c.from)) throw Error(`Mutation target missing: ${c.name}`);
  try {
    writeFileSync(c.file, original.replace(c.from, c.to));
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', c.test, '-t', c.match, '--pool=forks', '--reporter=verbose'], {
      env: { ...process.env, S08_TEMPORAL_BACKEND: 'dev' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    const output = result.stdout + result.stderr;
    writeFileSync(`evidence/mutation-${c.name}.txt`, output);
    if (result.status !== 1 || !output.includes(c.failure)) throw Error(`Mutation was not caught by the expected assertion: ${c.name}`);
    if (existsSync('.state') && readdirSync('.state').length) throw Error(`State leaked: ${c.name}`);
    summary.push(`${c.name}: detected by expected failing assertion; source restored; state empty`);
    console.log(summary.at(-1));
  } finally {
    writeFileSync(c.file, original);
    writeFileSync('evidence/mutation-summary.txt', summary.join('\n') + '\n');
  }
}
