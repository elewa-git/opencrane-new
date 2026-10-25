import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const homeDirectory = /\/(?:home|Users)\/[^/\s"'<>`\\]+/i;
const rootHomeDirectory = /(?<![\w./<>-])(?:file:\/\/)?\/root(?=\/|\s|["'`]|$)/;
const windowsHomeDirectory = /[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>`]+/i;
const privateStack = /[\\/]dev-stack-\d+\b/;
const emailAddress = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const rules = [
  { pattern: homeDirectory, description: 'home-directory path' },
  { pattern: rootHomeDirectory, description: 'home-directory path' },
  { pattern: windowsHomeDirectory, description: 'home-directory path' },
  { pattern: privateStack, description: 'private stack path' },
  { pattern: emailAddress, description: 'email address' },
];

function readTrackedFiles() {
  const options = { encoding: 'utf8' };
  const output = execFileSync('git', ['ls-files', '-z', '--', 'docs/process/'], options);
  const files = output.split('\0');
  files.pop();
  return files;
}

function checkFile(file) {
  const content = readFileSync(file);
  // Check text here. Screenshots still need visual inspection before publication.
  if (content.includes(0)) {
    return [];
  }
  const text = content.toString('utf8');
  const lines = text.split('\n');
  const problems = [];
  for (const [index, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        // Report the location without repeating the private value in CI logs.
        problems.push(`${file}:${index + 1}: replace ${rule.description} with a placeholder.`);
      }
    }
  }
  return problems;
}

function main() {
  const files = readTrackedFiles();
  const problems = [];
  for (const file of files) {
    problems.push(...checkFile(file));
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('PASS: tracked process text contains no home paths, private stack paths or emails.');
}

main();
