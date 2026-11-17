import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { baseCommit } from './baseline.mjs';

const categories = ['source', 'tests', 'evidence', 'other'];
const weekSeconds = 7 * 24 * 60 * 60;

export function classify(path) {
  if (path.startsWith('docs/process/')) return 'evidence';
  if (!/^(apps|libs)\/[^/]+\//u.test(path)) return 'other';
  if (/\.(test|spec)\.ts$/u.test(path)) return 'tests';
  if (/^(apps|libs)\/[^/]+\/test\//u.test(path)) return 'tests';
  if (/^(apps|libs)\/[^/]+\/src\/.*\.(ts|html|css)$/u.test(path)) return 'source';
  return 'other';
}

export function parseNumstat(text) {
  const changes = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+)\t(\d+)\t(.+)$/u.exec(line);
    if (!match) continue;
    let path = match[3];
    if (path.startsWith('"')) path = JSON.parse(path);
    const change = { path, added: Number(match[1]), deleted: Number(match[2]) };
    changes.push(change);
  }
  return changes;
}

export function ratio(counts) {
  if (counts.source === 0) return 'n/a';
  return (counts.tests / counts.source).toFixed(1);
}

function emptyChanges() {
  const counts = {};
  for (const category of categories) counts[category] = { added: 0, deleted: 0 };
  return counts;
}

function addChanges(counts, changes) {
  for (const change of changes) {
    const category = classify(change.path);
    counts[category].added += change.added;
    counts[category].deleted += change.deleted;
  }
}

export function weeklyChanges(text, now) {
  const weeks = [emptyChanges(), emptyChanges()];
  for (const commit of text.split(/^@(?=\d+\n)/mu)) {
    const newline = commit.indexOf('\n');
    const timestamp = Number(commit.slice(0, newline));
    const age = now - timestamp;
    if (newline < 0 || age < 0 || age > 2 * weekSeconds) continue;
    // Put the exact seven-day boundary in the recent week, without counting it twice.
    const week = age <= weekSeconds ? 0 : 1;
    addChanges(weeks[week], parseNumstat(commit.slice(newline + 1)));
  }
  return weeks;
}

function git(args) {
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], options);
}

function packageCounts(paths) {
  const packages = new Map();
  for (const path of paths) {
    if (!/^(apps|libs)\/[^/]+\/package.json$/u.test(path)) continue;
    const name = path.slice(0, -'/package.json'.length);
    const counts = { name, source: 0, tests: 0 };
    packages.set(name, counts);
  }
  for (const path of paths) {
    const category = classify(path);
    if (category !== 'source' && category !== 'tests') continue;
    const segments = path.split('/');
    const name = `${segments[0]}/${segments[1]}`;
    const counts = packages.get(name);
    if (!counts) continue;
    const content = readFileSync(path);
    // Count newline bytes, matching wc -l even when the final line has no newline.
    for (const byte of content) {
      if (byte === 10) counts[category] += 1;
    }
  }
  return Array.from(packages.values());
}

function collectReport(now, base, head) {
  const paths = git(['ls-files', '-z']).split('\0');
  const packages = packageCounts(paths);
  const total = { source: 0, tests: 0 };
  for (const counts of packages) {
    total.source += counts.source;
    total.tests += counts.tests;
  }
  const main = base || baseCommit() || 'HEAD';
  const since = new Date((now - 2 * weekSeconds) * 1000).toISOString();
  const history = git(['log', main, '--first-parent', '--no-renames', '--numstat',
    '--format=@%ct', `--since-as-filter=${since}`]);
  let pullRequest = null;
  if (base && head) {
    pullRequest = emptyChanges();
    const diff = git(['diff', '--no-renames', '--numstat', base, head]);
    addChanges(pullRequest, parseNumstat(diff));
  }
  return { packages, total, main, now, weeks: weeklyChanges(history, now), pullRequest };
}

function changeTable(label, counts) {
  const lines = [`### ${label}`, '', '| Category | Added | Deleted |', '| --- | ---: | ---: |'];
  for (const category of categories) {
    lines.push(`| ${category} | ${counts[category].added} | ${counts[category].deleted} |`);
  }
  return lines.join('\n');
}

function formatReport(report) {
  const lines = ['## Test size', '', '| Package | Source lines | Test lines | Test/source |',
    '| --- | ---: | ---: | ---: |'];
  for (const counts of report.packages) {
    lines.push(`| ${counts.name} | ${counts.source} | ${counts.tests} | ${ratio(counts)} |`);
  }
  lines.push(`| Total | ${report.total.source} | ${report.total.tests} | ${ratio(report.total)} |`);
  lines.push('', `Packages: ${report.packages.length}.`, '', '## Main line changes', '',
    `Through ${report.main}; measured at ${new Date(report.now * 1000).toISOString()}.`, '',
    changeTable('Last 7 days', report.weeks[0]), '',
    changeTable('Previous 7 days', report.weeks[1]));
  if (report.pullRequest) {
    lines.push('', '## Pull request changes', '', changeTable('Base to head', report.pullRequest));
  }
  lines.push('', `size-report:${JSON.stringify(report)}`, '');
  return lines.join('\n');
}

function run() {
  let output;
  try {
    const now = Math.floor(Date.now() / 1000);
    const report = collectReport(now, process.env.BASE_SHA, process.env.HEAD_SHA);
    output = formatReport(report);
  } catch (error) {
    // Keep the cause visible, but never turn missing report data into a CI gate.
    console.error('size-report: unable to collect report', error);
    output = '## Test size\n\nReport unavailable; see the log.\n\nsize-report:{"error":true}\n';
  }
  console.log(output.trimEnd());
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
  } catch (error) {
    console.error('size-report: unable to append job summary', error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
