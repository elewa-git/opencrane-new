type ReportKind = { type: string; executionMode?: string | undefined;
  senderAttemptId?: string | undefined };

export function needsPrivateExit(report: ReportKind) {
  const terminal = report.type === 'agent.turn_completed' || report.type === 'agent.turn_failed';
  return terminal && report.executionMode === 'restricted'
    && report.senderAttemptId === undefined;
}

export function isRoutineStartReport(report: ReportKind) {
  return report.type === 'agent.turn_started' && report.senderAttemptId !== undefined;
}
