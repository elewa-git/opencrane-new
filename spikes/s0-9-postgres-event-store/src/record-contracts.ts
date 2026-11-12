import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';

const assertionSchema = z.object({ title: z.string(), status: z.string() });
const suiteSchema = z.object({ name: z.string(), assertionResults: z.array(assertionSchema) });
const reportSchema = z.object({
  numPassedTests: z.number(), numFailedTests: z.number(), numPendingTests: z.number(),
  testResults: z.array(suiteSchema),
});
function summariseSuite(suite: z.infer<typeof suiteSchema>) {
  return { file: basename(suite.name), tests: suite.assertionResults };
}
const path = process.argv[2];
if (!path) throw new Error('Supply the Vitest JSON report');
const reportText = readFileSync(path, 'utf8');
const reportData: unknown = JSON.parse(reportText);
const report = reportSchema.parse(reportData);
const suites = report.testResults.map(summariseSuite);
const summary = { passed: report.numPassedTests, failed: report.numFailedTests,
  skipped: report.numPendingTests, suites };
writeFileSync('spikes/s0-9-postgres-event-store/results/contracts.json',
  `${JSON.stringify(summary, null, 2)}\n`);
