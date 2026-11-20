import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { eventRegistry } from '../libs/events/src/registry.ts';

// Resolve the existing web dependency without depending on npm's hoisting layout.
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const mermaidEntry = pathToFileURL(webRequire.resolve('mermaid'));
const { default: mermaid } = await import(mermaidEntry.href);
// Parse trusted repository text only. Loose mode avoids DOM sanitisation; nothing is rendered.
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

const overviewPath = 'docs/architecture/overview.md';
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

async function checkDiagram(diagram, number, errors) {
  const parsedDiagram = await mermaid.mermaidAPI.getDiagramFromText(diagram);
  const database = parsedDiagram.db;
  const participants = database.getActors();
  let arrows = 0;
  for (const message of database.getMessages()) {
    // Notes and control statements share the message list but do not draw arrows.
    if (message.from && message.to && message.type !== database.LINETYPE.NOTE) arrows += 1;
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
    await checkDiagram(diagram, index + 1, errors);
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
