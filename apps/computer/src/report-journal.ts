import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { record } from './http.ts';

export interface BridgeReport {
  sequence: number;
  previousSequence?: number;
  conversationId: string;
  turnId: string;
  assistantId: string;
  requesterId?: string;
  type: string;
  callId?: string;
  nativeRequestId?: string;
  requestKind?: 'shell' | 'file_change' | 'permissions' | 'user_input' | 'other';
  outcome?: 'declined' | 'unsupported';
  serverName?: string;
  serverId?: string;
  toolName?: string;
  status?: 'completed' | 'failed';
  durationMs?: number;
  commandDigest?: string;
  exitCode?: number;
  threadId?: string;
  messageId?: string;
  text?: string;
  executionMode?: 'restricted' | 'memory_free';
  sharingClass?: 'shared_only';
  reason?: 'restricted_tool_refused' | 'unsupported_native_consent'
    | 'stop_interrupted' | 'model_error';
  memoryOnly?: boolean;
}

interface ReportInput {
  executionMode?: 'restricted' | 'memory_free';
  sharingClass?: 'shared_only';
  id: string;
  conversationId: string;
  assistantId: string;
  requesterId?: string;
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
  const requesterId = optionalString(value, 'requesterId');
  if (requesterId) report.requesterId = requesterId;
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
  readToolDetails(value, report);
  readStorageDetails(value, report);
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
    for (const line of reportLines) {
      const report = parseStoredReport(line);
      reports.push(report);
    }

    const executionLines = readExecutionLines(`${driver.journal}.executions`);
    for (const turnId of executionLines) {
      executions.add(turnId);
    }
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
    if (input.requesterId) report.requesterId = input.requesterId;
    if (input.executionMode === 'restricted') report.executionMode = 'restricted';
    if (input.sharingClass === 'shared_only') {
      if (type === 'agent.turn_started') {
        report.sharingClass = 'shared_only';
      } else {
        function isTurnStart(saved: BridgeReport) {
          return saved.turnId === turnId && saved.conversationId === input.conversationId
            && saved.type === 'agent.turn_started';
        }
        const start = reports.find(isTurnStart);
        if (start?.threadId) report.threadId = start.threadId;
      }
    }
    if (input.executionMode === 'restricted' && report.text !== undefined) report.memoryOnly = true;
    const serializedReport = storedLine(report);
    const reportLine = `${serializedReport}\n`;
    appendFileSync(driver.journal, reportLine, { mode: 0o600, flush: true });
    reports.push(report);
    return report;
  }

  function forgetText(sequence: number) {
    const report = reports[sequence - 1];
    if (report?.memoryOnly) delete report.text;
  }

  function replay(since: number, waiting: Map<number, unknown>, send: (report: BridgeReport) => void) {
    for (const report of reports) {
      if (report.sequence <= since) forgetText(report.sequence);
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

  return { reports, executions, load, findLast, append, replay, recordExecution, forgetText };
}


function storedLine(report: BridgeReport) {
  if (!report.memoryOnly) return JSON.stringify(report);
  const { text: _text, ...outline } = report;
  return JSON.stringify(outline);
}

export function wireReport(report: BridgeReport): BridgeReport {
  if (!report.memoryOnly) return report;
  if (report.text !== undefined) {
    const { memoryOnly: _memoryOnly, ...withText } = report;
    return withText;
  }
  const lost: BridgeReport = {
    sequence: report.sequence,
    conversationId: report.conversationId,
    turnId: report.turnId,
    assistantId: report.assistantId,
    type: 'agent.output_lost',
  };
  if (report.previousSequence !== undefined) lost.previousSequence = report.previousSequence;
  if (report.requesterId !== undefined) lost.requesterId = report.requesterId;
  if (report.threadId !== undefined) lost.threadId = report.threadId;
  return lost;
}

function readStorageDetails(value: Record<string, unknown>, report: BridgeReport) {
  const mode = value['executionMode'];
  if (mode !== undefined) {
    if (mode !== 'restricted' && mode !== 'memory_free') throw new Error('Invalid journal mode');
    report.executionMode = mode;
  }
  const sharingClass = value['sharingClass'];
  if (sharingClass !== undefined) {
    if (sharingClass !== 'shared_only' || mode !== 'restricted') {
      throw new Error('Invalid journal context class');
    }
    report.sharingClass = 'shared_only';
  }
  const reason = value['reason'];
  if (reason !== undefined) {
    if (reason !== 'restricted_tool_refused' && reason !== 'unsupported_native_consent'
      && reason !== 'stop_interrupted' && reason !== 'model_error') {
      throw new Error('Invalid journal reason');
    }
    report.reason = reason;
  }
  const memoryOnly = value['memoryOnly'];
  if (memoryOnly !== undefined) {
    if (typeof memoryOnly !== 'boolean') throw new Error('Invalid journal storage');
    report.memoryOnly = memoryOnly;
  }
}

function readToolDetails(value: Record<string, unknown>, report: BridgeReport) {
  readNativeDetails(value, report);
  const callId = optionalString(value, 'callId');
  const serverId = optionalString(value, 'serverId');
  const toolName = optionalString(value, 'toolName');
  const durationMs = optionalNumber(value, 'durationMs');
  const status = value['status'];
  if (callId !== undefined) report.callId = callId;
  if (serverId !== undefined) report.serverId = serverId;
  if (toolName !== undefined) report.toolName = toolName;
  if (durationMs !== undefined) report.durationMs = durationMs;
  if (status !== undefined) {
    if (status !== 'completed' && status !== 'failed') throw new Error('Invalid tool status');
    report.status = status;
  }
}

function readNativeDetails(value: Record<string, unknown>, report: BridgeReport) {
  const requestKind = value['requestKind'];
  if (requestKind !== undefined) {
    if (requestKind !== 'shell' && requestKind !== 'file_change' && requestKind !== 'permissions'
      && requestKind !== 'user_input' && requestKind !== 'other') throw new Error('Invalid request kind');
    report.requestKind = requestKind;
  }
  const outcome = value['outcome'];
  if (outcome !== undefined) {
    if (outcome !== 'declined' && outcome !== 'unsupported') throw new Error('Invalid request outcome');
    report.outcome = outcome;
  }
  const nativeRequestId = optionalString(value, 'nativeRequestId');
  const serverName = optionalString(value, 'serverName');
  if (nativeRequestId !== undefined) report.nativeRequestId = nativeRequestId;
  if (serverName !== undefined) report.serverName = serverName;
}
