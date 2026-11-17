import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const ledgerPath = 'docs/process/ledger.md';
const expectedIds = ['#10', '#11'];
for (const [phase, count] of [[2, 7], [3, 22], [4, 28]]) {
  for (let index = 1; index <= count; index += 1) {
    expectedIds.push(`P${phase}-${index}`);
  }
}

function readRows() {
  const text = readFileSync(ledgerPath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) {
      continue;
    }
    const cells = line.split('|');
    const capability = cells[1].trim();
    const id = capability.split(' ')[0];
    if (!/^(?:#\d+|P[234]-\d+)$/.test(id)) {
      continue;
    }
    const row = { id, source: cells[3]?.trim(), live: cells[4]?.trim(),
      receipt: cells[5]?.trim(), columns: cells.length - 2 };
    rows.push(row);
  }
  return rows;
}

function hasDateAndCommit(cell) {
  return /\b\d{4}-\d{2}-\d{2}\b/.test(cell) && /`[a-f0-9]{7,40}`/.test(cell);
}

function hasReceiptFile(cell) {
  const link = /^\[[^\]]+\]\(([^)]+)\)$/.exec(cell ?? '');
  if (!link || /^(?:[a-z]+:|\/)/i.test(link[1])) {
    return false;
  }
  const target = link[1].split('#')[0];
  const path = resolve(dirname(ledgerPath), target);
  if (!target || !path.startsWith(`${process.cwd()}${sep}`)) {
    return false;
  }
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function checkRow(row) {
  const problems = [];
  if (row.columns !== 5) {
    problems.push(`${row.id}: expected five columns`);
  }
  if (!/^(?:No|Part|Yes)(?: |$)/.test(row.source ?? '')) {
    problems.push(`${row.id}: unknown source label`);
  }
  if (!/^(?:PASS|FAIL|PARTIAL|NOT RUN)(?: |$)/.test(row.live ?? '')) {
    problems.push(`${row.id}: unknown live label`);
  }
  if (/^(?:PASS|FAIL|PARTIAL)(?: |$)/.test(row.live ?? '')) {
    if (!hasDateAndCommit(row.live)) {
      problems.push(`${row.id}: live result needs a UTC date and commit`);
    }
    if (!hasReceiptFile(row.receipt)) {
      problems.push(`${row.id}: live result needs an existing receipt file`);
    }
  }
  return problems;
}

function main() {
  const rows = readRows();
  const counts = new Map();
  const problems = [];
  for (const row of rows) {
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    if (!expectedIds.includes(row.id)) {
      problems.push(`unknown id: ${row.id}`);
    }
    problems.push(...checkRow(row));
  }
  let missing = 0;
  let duplicated = 0;
  for (const id of expectedIds) {
    if (!counts.has(id)) {
      missing += 1;
      problems.push(`missing id: ${id}`);
    } else if (counts.get(id) > 1) {
      duplicated += 1;
      problems.push(`duplicated id: ${id}`);
    }
  }
  console.log(`${rows.length} rows, ${missing} missing ids, ${duplicated} duplicated ids, `
    + `${problems.length} violations`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

main();
