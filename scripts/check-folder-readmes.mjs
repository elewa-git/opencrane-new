import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { baseCommit, readAtBase, mustNotRise } from './ci/baseline.mjs';

const baselinePath = 'scripts/readme-baseline.json';

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
  if (!checkHeadings(sections)) problems.push({ file: readme, rule: 'headings' });
  if (!checkOpening(readme, sections)) problems.push({ file: readme, rule: 'opening' });
  const summary = checkSummary(sections);
  if (summary) problems.push({ file: readme, rule: 'summary', count: summary });
  const length = checkLength(content, 150);
  if (length) problems.push({ file: readme, rule: 'length', count: length });
  return problems;
}

function findEntry(entries, expected) {
  function matches(entry) {
    return entry.file === expected.file && entry.rule === expected.rule;
  }
  return entries.find(matches);
}

function checkBaseline(listed, actual) {
  const problems = [];
  for (const entry of actual) {
    const allowed = findEntry(listed, entry);
    const label = `${entry.file}: ${entry.rule}`;
    if (!allowed) problems.push(`${label}: ${entry.count ?? 'failed'} (unlisted offender)`);
    else if (entry.rule === 'length' || entry.rule === 'summary') {
      const problem = mustNotRise(label, allowed.count, entry.count);
      if (problem) problems.push(problem);
    }
  }
  for (const entry of listed) {
    if (!findEntry(actual, entry)) {
      problems.push(`${entry.file}: ${entry.rule}: remove the passing baseline entry`);
    }
  }
  return problems;
}

function compareWithBase(listed) {
  if (!baseCommit()) return [];
  const previous = readAtBase(baselinePath);
  // Allow the first ledger; later commits may only remove entries or lower counts.
  if (previous === undefined) return [];
  const before = JSON.parse(previous);
  validateBaseline(before);
  const problems = [];
  for (const entry of listed) {
    const old = findEntry(before, entry);
    const label = `${entry.file}: ${entry.rule}`;
    if (!old) problems.push(`${label}: new baseline entry`);
    else if (entry.count !== undefined) {
      const problem = mustNotRise(label, old.count, entry.count);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function validateBaseline(entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid README baseline: expected a list');
  const seen = new Set();
  const limits = { length: 150, summary: 10, 'robot-length': 1500 };
  for (const entry of entries) {
    const key = `${entry.file}:${entry.rule}`;
    const limit = limits[entry.rule];
    const knownRule = entry.rule === 'headings' || entry.rule === 'opening' || limit !== undefined;
    if (typeof entry.file !== 'string' || !knownRule || seen.has(key)) {
      throw new Error(`Invalid baseline entry: ${key}`);
    }
    if (limit !== undefined && (!Number.isSafeInteger(entry.count) || entry.count <= limit)) {
      throw new Error(`Invalid baseline entry count: ${key}`);
    }
    if (limit === undefined && entry.count !== undefined) {
      throw new Error(`Invalid baseline entry count: ${key}`);
    }
    seen.add(key);
  }
}

function main() {
  const files = readTrackedFiles();
  const folders = collectFolders(files);
  const problems = [];
  const violations = [];
  for (const folder of folders) {
    problems.push(...checkFolder(folder, files));
    const readme = `${folder}/README.md`;
    if (folder.split('/').length === 2 && files.has(readme) && existsSync(readme)) {
      violations.push(...checkPackage(readme));
    }
  }
  for (const file of files) {
    const group = file.split('/')[0];
    if (packageGroups.has(group) && file.endsWith('/README.robot.md') && existsSync(file)) {
      const length = checkLength(readFileSync(file, 'utf8'), 1500);
      if (length) violations.push({ file, rule: 'robot-length', count: length });
    }
  }
  const listed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  validateBaseline(listed);
  problems.push(...checkBaseline(listed, violations));
  problems.push(...compareWithBase(listed));
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('Folder READMEs pass; package and robot exceptions match the baseline.');
}

main();
