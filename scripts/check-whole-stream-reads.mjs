import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { baseCommit, readAtBase, mustNotRise } from './ci/baseline.mjs';

const baselinePath = 'scripts/whole-stream-reads.json';
const rebuildFiles = [
  'libs/projections/src/runner.ts',
  'apps/ops/src/replay.ts',
  'libs/authz/src/rebuild.ts',
];

function isProductFile(file) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) return false;
  const parts = file.split('/');
  if (parts[0] === 'libs') return parts[2] === 'src';
  return parts[0] === 'apps' && ['server', 'ops'].includes(parts[1]) && parts[2] === 'src';
}

function isOne(node) {
  return node !== undefined && ts.isNumericLiteral(node) && node.text === '1';
}

function isWholeStreamRead(node) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'readStream') return false;
  const second = node.arguments[1];
  if (node.arguments.length === 1 || isOne(second)) return true;
  return second !== undefined && ts.isIdentifier(second) && second.text === 'undefined';
}

function isWholeStreamCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'history') return true;
    return callee.text === 'readEvents' && isOne(node.arguments[1]);
  }
  return isWholeStreamRead(node);
}

function readLocations(file) {
  const content = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const locations = [];
  function visit(node) {
    if (isWholeStreamCall(node)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      locations.push(`${file}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return locations;
}

function scanReads() {
  const options = { encoding: 'utf8' };
  const argumentsList = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const output = execFileSync('git', argumentsList, options);
  const files = new Set(output.split('\0'));
  const reads = new Map();
  for (const file of files) {
    if (!isProductFile(file) || !existsSync(file)) continue;
    const locations = readLocations(file);
    if (locations.length > 0) reads.set(file, locations);
  }
  return reads;
}

function invalidBaseline(detail) {
  throw new Error(`Invalid whole-stream baseline: ${detail}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOneLineReason(reason) {
  return typeof reason === 'string' && reason.trim() !== '' &&
    !reason.includes('\n') && !reason.includes('\r');
}

function validateRebuild(entries, known) {
  const files = Object.keys(entries);
  if (files.length !== rebuildFiles.length) invalidBaseline('expected exactly three rebuild files');
  for (const file of rebuildFiles) {
    const entry = entries[file];
    if (!isRecord(entry)) invalidBaseline(`missing rebuild file: ${file}`);
    if (Object.hasOwn(known, file)) invalidBaseline(`file in both lists: ${file}`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) invalidBaseline(file);
    if (!isOneLineReason(entry.reason)) invalidBaseline(file);
  }
}

function validateBaseline(baseline) {
  if (!isRecord(baseline) || !isRecord(baseline.known) || !isRecord(baseline.rebuild)) {
    invalidBaseline('expected known and rebuild maps');
  }
  for (const [file, count] of Object.entries(baseline.known)) {
    if (!isProductFile(file) || !Number.isSafeInteger(count) || count <= 0) {
      invalidBaseline(file);
    }
  }
  validateRebuild(baseline.rebuild, baseline.known);
}

function recordedCounts(baseline) {
  const counts = new Map(Object.entries(baseline.known));
  for (const [file, entry] of Object.entries(baseline.rebuild)) counts.set(file, entry.count);
  return counts;
}

function checkCounts(baseline, reads) {
  const counts = recordedCounts(baseline);
  const files = new Set([...counts.keys(), ...reads.keys()]);
  const problems = [];
  for (const file of files) {
    const locations = reads.get(file) ?? [];
    const recorded = counts.get(file) ?? 0;
    if (locations.length === recorded) continue;
    problems.push(`${file}: recorded ${recorded}, found ${locations.length}; update removed reads`);
    problems.push(...locations);
  }
  return problems;
}

function compareWithBase(baseline) {
  if (!baseCommit()) return [];
  const previous = readAtBase(baselinePath);
  // Allow the first baseline; later changes may only remove reads and lower counts.
  if (previous === undefined) return [];
  const before = JSON.parse(previous);
  validateBaseline(before);
  const problems = [];
  for (const group of ['known', 'rebuild']) {
    for (const [file, entry] of Object.entries(baseline[group])) {
      if (!Object.hasOwn(before[group], file)) {
        problems.push(`${file}: new baseline entry in ${group}`);
        continue;
      }
      let count = entry;
      let oldCount = before[group][file];
      if (group === 'rebuild') {
        count = entry.count;
        oldCount = oldCount.count;
      }
      const problem = mustNotRise(file, oldCount, count);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function printTotals(baseline) {
  let knownTotal = 0;
  let rebuildTotal = 0;
  for (const count of Object.values(baseline.known)) knownTotal += count;
  for (const entry of Object.values(baseline.rebuild)) rebuildTotal += entry.count;
  console.log(`Whole-stream reads — known: ${knownTotal}; rebuild: ${rebuildTotal}.`);
}

function main() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  validateBaseline(baseline);
  const reads = scanReads();
  const problems = checkCounts(baseline, reads);
  problems.push(...compareWithBase(baseline));
  printTotals(baseline);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

main();
