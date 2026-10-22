import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function isDocumentation(file) {
  const protectedFiles = [
    'scripts/ci/select.mjs', 'scripts/ci/sequencer.mjs', 'scripts/ci/test-timings.json',
  ];
  if (file.startsWith('.github/') || file.startsWith('docs/process/evidence/') ||
      protectedFiles.includes(file)) {
    return false;
  }
  return file.startsWith('docs/') || file.startsWith('changes/') ||
    file.endsWith('.md') || file.endsWith('.png');
}

export function selectRun(eventName, files) {
  if (eventName === 'pull_request' && files.length > 0 && files.every(isDocumentation)) {
    return 'docs';
  }
  return 'full';
}

export function isDocsDecision(decision) {
  return decision === 'docs';
}

export function jobsPassed(decision, checks, tests, fixtures) {
  if (checks !== 'success') {
    return false;
  }
  if (isDocsDecision(decision)) {
    return tests === 'skipped' && fixtures === 'skipped';
  }
  return tests === 'success' && fixtures === 'success';
}

function main() {
  const [eventName, base, head] = process.argv.slice(2);
  if (eventName === 'gate') {
    const passed = jobsPassed(process.env.CI_DECISION, process.env.CHECKS_RESULT,
      process.env.TEST_RESULT, process.env.FIXTURES_RESULT);
    if (!passed) {
      throw new Error('Required CI jobs did not pass');
    }
    return;
  }
  let decision = 'full';
  if (eventName === 'pull_request') {
    // Include both names of a rename so moving code into docs cannot hide a deletion.
    const options = { encoding: 'utf8' };
    const diff = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head],
      options);
    const files = diff.split('\0');
    files.pop();
    decision = selectRun(eventName, files);
  }
  console.log(decision);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${decision}\n`);
  }
}

if (process.argv[1] === '-' || import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
