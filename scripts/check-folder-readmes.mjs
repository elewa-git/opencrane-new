import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const packageGroups = new Set(['apps', 'libs', 'infra', 'tools']);
const excludedFolders = new Set([
  'test', 'tests', '__tests__', 'fixtures', '__snapshots__', 'dist', 'coverage', 'node_modules',
]);
const ticketReference = /#\d+\b|\bP\d+-\d+\b|\bphase\s+\d+\b|\bPR\s+\d+\b/i;

function readTrackedFiles() {
  const options = { encoding: 'utf8' };
  const output = execFileSync('git', ['ls-files', '-z'], options);
  const files = output.split('\0');
  files.pop();
  return new Set(files);
}

function collectFolders(files) {
  const folders = new Set();
  for (const file of files) {
    const parts = file.split('/');
    if (!packageGroups.has(parts[0])) {
      continue;
    }
    for (let length = 2; length < parts.length; length++) {
      if (length > 2 && excludedFolders.has(parts[length - 1])) {
        break;
      }
      const folderParts = parts.slice(0, length);
      const folder = folderParts.join('/');
      folders.add(folder);
    }
  }
  const sortedFolders = [...folders];
  sortedFolders.sort();
  return sortedFolders;
}

function isTopLevelSource(folder) {
  const parts = folder.split('/');
  return parts.length === 3 && parts[2] === 'src';
}

function checkTicketReferences(readme) {
  const content = readFileSync(readme, 'utf8');
  const lines = content.split('\n');
  const problems = [];
  for (const [index, line] of lines.entries()) {
    if (ticketReference.test(line)) {
      problems.push(`Remove ticket or phase references from ${readme}:${index + 1}.`);
    }
  }
  return problems;
}

function checkFolder(folder, files) {
  const readme = `${folder}/README.md`;
  if (files.has(readme) && existsSync(readme)) {
    return checkTicketReferences(readme);
  }
  if (isTopLevelSource(folder)) {
    return [];
  }
  return [`Missing README.md in folder: ${folder}`];
}

function main() {
  const files = readTrackedFiles();
  const folders = collectFolders(files);
  const problems = [];
  for (const folder of folders) {
    problems.push(...checkFolder(folder, files));
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Every checked folder has a README.md without ticket or phase references.');
}

main();
