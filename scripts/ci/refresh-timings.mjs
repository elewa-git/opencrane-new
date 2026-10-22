import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function compareNumbers(first, second) {
  return first - second;
}

function median(values) {
  values.sort(compareNumbers);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }
  return (values[middle - 1] + values[middle]) / 2;
}

export function rebuildTimings(reports, root) {
  const samples = new Map();
  for (const report of reports) {
    for (const result of report.testResults) {
      const file = relative(root, result.name);
      const duration = result.endTime - result.startTime;
      if (!/^(apps|libs)\/.+\.test\.ts$/.test(file) ||
          !Number.isFinite(duration) || duration < 0) {
        throw new Error('Invalid test timing');
      }
      const durations = samples.get(file) ?? [];
      durations.push(duration);
      samples.set(file, durations);
    }
  }
  const timings = {};
  const files = [...samples.keys()].sort();
  for (const file of files) {
    timings[file] = median(samples.get(file));
  }
  return timings;
}

function readReport(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function main() {
  const [root, ...reportFiles] = process.argv.slice(2);
  if (!root || reportFiles.length === 0) {
    throw new Error('Usage: node scripts/ci/refresh-timings.mjs <original-root> <reports...>');
  }
  const reports = reportFiles.map(readReport);
  const timings = rebuildTimings(reports, root);
  // Keep this generated data compact; the script always sorts its paths.
  writeFileSync('scripts/ci/test-timings.json', `${JSON.stringify(timings)}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
