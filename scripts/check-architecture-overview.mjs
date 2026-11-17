import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eventRegistry } from '../libs/events/src/registry.ts';

const overviewPath = 'docs/architecture/overview.md';
const arrowPattern = /^\s*([\w-]+?)\s*(?:<<)?[-.]+(?:>>?|[x)])\s*[+-]?\s*([\w-]+)\s*:/u;
const eventPattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

function trackedPaths() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  const paths = new Set();
  for (const file of output.split('\0')) {
    if (!file) continue;
    paths.add(file);
    let folder = path.posix.dirname(file);
    while (folder !== '.') {
      paths.add(folder);
      folder = path.posix.dirname(folder);
    }
  }
  return paths;
}

function checkLineCount(markdown, errors) {
  const lines = markdown.split('\n');
  // Count lines like wc -l, without treating the final newline as another line.
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 250) errors.push(`Page exceeds 250 lines: ${lines.length}`);
}

function sequenceDiagrams(markdown) {
  const diagrams = [];
  const blocks = markdown.matchAll(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gmu);
  for (const block of blocks) {
    if (/^\s*sequenceDiagram\s*$/mu.test(block[1])) diagrams.push(block[1]);
  }
  return diagrams;
}

function hasMultipleStatements(line) {
  const trimmedLine = line.trimStart();
  if (trimmedLine.startsWith('%%')) return false;
  // Ignore separators inside Mermaid's quoted participant names.
  const withoutQuotedText = line.replace(/"[^"]*"/gu, '""');
  const statements = withoutQuotedText.split(';');
  let statementCount = 0;
  for (const statement of statements) {
    if (statement.trim() !== '') statementCount += 1;
  }
  return statementCount > 1;
}

function checkDiagram(diagram, number, errors) {
  const participants = new Set();
  let arrows = 0;
  for (const line of diagram.split('\n')) {
    if (hasMultipleStatements(line)) {
      errors.push(`Diagram ${number} must use one statement per line`);
      continue;
    }
    const declaration = /^\s*(?:participant|actor)\s+([\w-]+)/u.exec(line);
    if (declaration) participants.add(declaration[1]);
    const arrow = arrowPattern.exec(line);
    if (arrow) {
      participants.add(arrow[1]);
      participants.add(arrow[2]);
      arrows += 1;
    }
  }
  if (participants.size > 8) {
    errors.push(`Diagram ${number} exceeds 8 participants: ${participants.size}`);
  }
  if (arrows > 25) errors.push(`Diagram ${number} exceeds 25 arrows: ${arrows}`);
}

function checkNames(markdown, paths, errors) {
  const eventTypes = new Set();
  const families = new Set();
  for (const entry of eventRegistry) {
    eventTypes.add(entry.type);
    families.add(entry.type.split('.')[0]);
  }
  const names = markdown.matchAll(/(?<!`)`([^`\n]+)`(?!`)/gu);
  for (const match of names) {
    const name = match[1];
    const withoutTrailingSlash = name.replace(/\/$/u, '');
    if (name.includes('/') && !paths.has(withoutTrailingSlash)) {
      errors.push(`Untracked path: ${name}`);
    }
    const family = name.split('.')[0];
    if (eventPattern.test(name) && families.has(family) && !eventTypes.has(name)) {
      errors.push(`Unknown event: ${name}`);
    }
  }
}

async function main() {
  const markdown = await readFile(overviewPath, 'utf8');
  const errors = [];
  checkLineCount(markdown, errors);
  const diagrams = sequenceDiagrams(markdown);
  if (diagrams.length !== 3) errors.push('Page must contain exactly 3 sequence diagrams');
  for (const [index, diagram] of diagrams.entries()) {
    checkDiagram(diagram, index + 1, errors);
  }
  checkNames(markdown, trackedPaths(), errors);
  if (errors.length > 0) {
    console.error('check:overview — FAILED');
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log('check:overview — OK');
}

await main();
