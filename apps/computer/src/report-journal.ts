import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { record } from './http.ts';

export interface BridgeReport {
  sequence: number;
  previousSequence?: number;
  conversationId: string;
  turnId: string;
  assistantId: string;
  type: string;
  commandDigest?: string;
  exitCode?: number;
  threadId?: string;
  messageId?: string;
  text?: string;
}

interface ReportInput {
  id: string;
  conversationId: string;
  assistantId: string;
}

interface JournalDriver {
  journal: string;
}

function requiredString(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result !== 'string' || !result) {
    throw new Error('Invalid bridge field');
  }
  return result;
}

function optionalString(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result === 'string') {
    return result;
  }
  return undefined;
}

function optionalNumber(value: Record<string, unknown>, name: string) {
  const result = value[name];
  if (typeof result === 'number') {
    return result;
  }
  return undefined;
}

function parseStoredReport(line: string): BridgeReport {
  const value = record(JSON.parse(line) as unknown);
  const sequence = value['sequence'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
    throw new Error('Invalid journal');
  }

  const report: BridgeReport = {
    sequence,
    conversationId: requiredString(value, 'conversationId'),
    turnId: requiredString(value, 'turnId'),
    assistantId: requiredString(value, 'assistantId'),
    type: requiredString(value, 'type'),
  };
  const previousSequence = optionalNumber(value, 'previousSequence');
  const commandDigest = optionalString(value, 'commandDigest');
  const exitCode = optionalNumber(value, 'exitCode');
  const threadId = optionalString(value, 'threadId');
  const messageId = optionalString(value, 'messageId');
  const text = optionalString(value, 'text');

  if (previousSequence !== undefined) {
    report.previousSequence = previousSequence;
  }
  if (commandDigest !== undefined) {
    report.commandDigest = commandDigest;
  }
  if (exitCode !== undefined) {
    report.exitCode = exitCode;
  }
  if (threadId !== undefined) {
    report.threadId = threadId;
  }
  if (messageId !== undefined) {
    report.messageId = messageId;
  }
  if (text !== undefined) {
    report.text = text;
  }
  return report;
}

function hasContent(line: string) {
  return line.length > 0;
}

function readReportLines(path: string) {
  if (!existsSync(path)) {
    return [];
  }
  const fileContents = readFileSync(path, 'utf8');
  const contents = fileContents.trim();
  if (!contents) {
    return [];
  }
  const lines = contents.split('\n');
  return lines.filter(hasContent);
}

function readExecutionLines(path: string) {
  if (!existsSync(path)) {
    return [];
  }
  const fileContents = readFileSync(path, 'utf8');
  const contents = fileContents.trim();
  if (!contents) {
    return [];
  }
  const lines = contents.split('\n');
  return lines;
}

export function reportJournal(driver: JournalDriver) {
  const reports: BridgeReport[] = [];
  const executions = new Set<string>();

  function load() {
    const reportLines = readReportLines(driver.journal);
    for (const line of reportLines) reports.push(parseStoredReport(line));

    const executionLines = readExecutionLines(`${driver.journal}.executions`);
    for (const turnId of executionLines) executions.add(turnId);
  }

  function findLast(predicate: (report: BridgeReport) => boolean) {
    return reports.findLast(predicate);
  }

  function append(input: ReportInput | BridgeReport, type: string,
    extra: Partial<BridgeReport> = {}) {
    let turnId: string;
    if ('id' in input) {
      turnId = input.id;
    } else {
      turnId = input.turnId;
    }

    function isPreviousConversationReport(report: BridgeReport) {
      return report.conversationId === input.conversationId;
    }
    const previousReport = findLast(isPreviousConversationReport);
    const report: BridgeReport = {
      conversationId: input.conversationId,
      assistantId: input.assistantId,
      turnId,
      type,
      ...extra,
      previousSequence: previousReport?.sequence ?? 0,
      sequence: reports.length + 1,
    };
    const serializedReport = JSON.stringify(report);
    const reportLine = `${serializedReport}\n`;
    appendFileSync(driver.journal, reportLine, { mode: 0o600, flush: true });
    reports.push(report);
    return report;
  }

  function replay(since: number, waiting: Map<number, unknown>, send: (report: BridgeReport) => void) {
    for (const report of reports) {
      if (report.sequence > since || waiting.has(report.sequence)) {
        send(report);
      }
    }
  }

  function recordExecution(turnId: string) {
    const executionPath = `${driver.journal}.executions`;
    const executionLine = `${turnId}\n`;
    appendFileSync(executionPath, executionLine, { mode: 0o600, flush: true });
    executions.add(turnId);
  }

  return { reports, executions, load, findLast, append, replay, recordExecution };
}
