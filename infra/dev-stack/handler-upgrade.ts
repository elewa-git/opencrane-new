type SubscriptionChange = {
  handler: string;
  addedTypes: string[];
  removedTypes: string[];
  eventCount: number;
};

type UpgradeReport = {
  manifestChanged: boolean;
  plan: SubscriptionChange[];
  failedJobs: unknown[];
};

const command = 'npm run ops -- upgrade-handlers';

function isChange(value: unknown): value is SubscriptionChange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const change = value as Partial<SubscriptionChange>;
  const eventCount = change.eventCount;
  return typeof change.handler === 'string' &&
    Array.isArray(change.addedTypes) && Array.isArray(change.removedTypes) &&
    typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0;
}

function readReport(output: string): UpgradeReport {
  const line = output.trim().split('\n').at(-1);
  const value: unknown = JSON.parse(line ?? '');
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid report');
  }
  const report = value as Partial<UpgradeReport>;
  if (typeof report.manifestChanged !== 'boolean' ||
      !Array.isArray(report.plan) || !report.plan.every(isChange) ||
      !Array.isArray(report.failedJobs)) {
    throw new Error('Invalid report');
  }
  if (!report.manifestChanged && report.plan.length > 0) {
    throw new Error('Invalid report');
  }
  return report as UpgradeReport;
}

function safeChange(change: SubscriptionChange): boolean {
  return change.eventCount === 0 || change.removedTypes.length === 0;
}

export async function upgradeBeforeApps(execute: (flag: string) => Promise<string>): Promise<void> {
  let preview: UpgradeReport;
  try {
    preview = readReport(await execute('--dry-run'));
  } catch {
    throw new Error(`Handler upgrade preview failed. Run ${command} --dry-run with data services up.`);
  }
  if (!preview.manifestChanged) {
    return;
  }
  if (!preview.plan.every(safeChange)) {
    throw new Error(`Handler subscriptions need maintenance. Run ${command} --dry-run, ` +
      `then ${command} --confirm-writers-stopped after checking the plan.`);
  }
  try {
    await execute('--confirm-writers-stopped');
  } catch {
    throw new Error(`Handler upgrade failed. Run ${command} --dry-run and check stopped services.`);
  }
  console.log('Applied safe handler subscription upgrade before starting apps.');
}
