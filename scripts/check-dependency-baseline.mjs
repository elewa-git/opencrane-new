import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { mustNotRise, readAtBase } from './ci/baseline.mjs';

const baselinePath = '.dependency-cruiser-known-violations.json';
const cruiser = fileURLToPath(new URL('../node_modules/.bin/depcruise', import.meta.url));

function currentViolations() {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const [command] = manifest.scripts['lint:deps'].split('&&');
  const trimmedCommand = command.trim();
  const [executable, ...args] = trimmedCommand.split(/\s+/);
  if (executable !== 'depcruise') throw new Error('lint:deps must start with depcruise');
  // Read every violation, including those ignored by the ordinary lint command.
  args.push('--no-ignore-known', '--output-type', 'baseline');
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const output = execFileSync(cruiser, args, options);
  return JSON.parse(output);
}

function describe(entry) {
  return `${entry.rule.name}: ${entry.from} → ${entry.to}`;
}

function compareViolations(listed, actual) {
  const problems = [];
  const remaining = [...actual];
  for (const entry of listed) {
    function matches(candidate) {
      return isDeepStrictEqual(entry, candidate);
    }
    const index = remaining.findIndex(matches);
    if (index === -1) problems.push(`${describe(entry)}: no longer occurs; remove from baseline`);
    else remaining.splice(index, 1);
  }
  for (const entry of remaining) {
    problems.push(`${describe(entry)}: new violation outside the baseline`);
  }
  return problems;
}

function main() {
  const listed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const problems = compareViolations(listed, currentViolations());
  const previous = readAtBase(baselinePath);
  if (previous !== undefined) {
    const before = JSON.parse(previous);
    const problem = mustNotRise('Dependency baseline entries', before.length, listed.length);
    if (problem) problems.push(problem);
  }
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}

main();
