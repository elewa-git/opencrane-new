import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

const requiredHeadings = [
  'What this is', 'Where it fits', 'What it is responsible for',
  'Processes it handles', 'How to run or test it', 'Where to read more',
];

function readSections(content) {
  const sections = [];
  let fence;
  for (const line of content.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] &&
          marker[1].length >= fence.length && marker[2].trim() === '') {
        fence = undefined;
      }
    } else if (marker) {
      fence = marker[1];
    } else {
      const heading = /^ {0,3}##[ \t]+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        sections.push({ heading: heading[1], lines: [] });
        continue;
      }
    }
    if (sections.length > 0) sections.at(-1).lines.push(line);
  }
  return sections;
}

function checkHeadings(sections) {
  const actual = [];
  for (const section of sections) actual.push(section.heading);
  if (actual.length === 7 && actual[5] === 'Folders') actual.splice(5, 1);
  if (actual.length !== requiredHeadings.length) return false;
  for (const [index, heading] of requiredHeadings.entries()) {
    if (actual[index] !== heading) return false;
  }
  return true;
}

function normaliseText(text) {
  const withoutLinks = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const withoutCode = withoutLinks.replace(/`+/g, '');
  const joined = withoutCode.replace(/\s+/g, ' ');
  return joined.trim().replace(/\.$/, '');
}

function checkOpening(readme, sections) {
  const manifest = `${dirname(readme)}/package.json`;
  if (!existsSync(manifest)) return true;
  const { description } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!description) return true;
  const summary = sections.find(isSummary);
  if (!summary) return false;
  const opening = normaliseText(summary.lines.join(' '));
  const expected = normaliseText(description);
  if (!opening.startsWith(expected)) return false;
  return /^(?:[.\s]|$)/.test(opening.slice(expected.length));
}

function isSummary(section) {
  return section.heading === 'What this is';
}

function countLines(content) {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

function checkLength(content, limit) {
  const count = countLines(content);
  if (count > limit) return count;
  return undefined;
}

function checkSummary(sections) {
  const summary = sections.find(isSummary);
  if (!summary) return undefined;
  let count = 0;
  for (const line of summary.lines) {
    if (line.trim() !== '') count++;
  }
  if (count > 10) return count;
  return undefined;
}

function checkPackage(readme) {
  const content = readFileSync(readme, 'utf8');
  const sections = readSections(content);
  const problems = [];
  if (!checkHeadings(sections)) problems.push(`${readme}: headings: use the six headings in order`);
  if (!checkOpening(readme, sections)) problems.push(`${readme}: opening: start with the description`);
  const summary = checkSummary(sections);
  if (summary) problems.push(`${readme}: summary: ${summary} non-blank lines exceeds 10`);
  const length = checkLength(content, 150);
  if (length) problems.push(`${readme}: length: ${length} lines exceeds 150`);
  return problems;
}

function main() {
  const files = readTrackedFiles();
  const folders = collectFolders(files);
  const problems = [];
  for (const folder of folders) {
    problems.push(...checkFolder(folder, files));
    const readme = `${folder}/README.md`;
    if (folder.split('/').length === 2 && files.has(readme) && existsSync(readme)) {
      problems.push(...checkPackage(readme));
    }
  }
  for (const file of files) {
    const group = file.split('/')[0];
    if (packageGroups.has(group) && file.endsWith('/README.robot.md') && existsSync(file)) {
      const length = checkLength(readFileSync(file, 'utf8'), 1500);
      if (length) problems.push(`${file}: robot-length: ${length} lines exceeds 1500`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Every checked folder has a README.md without ticket or phase references.');
}

main();
