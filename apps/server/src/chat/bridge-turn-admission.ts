import type { tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { routineStartRefusal } from '../routine-bridge.ts';
import { recordBudgetRefusal } from './budget-refusal.ts';
import { childRequestStage } from './child-hold.ts';
import { requestChildStart } from './child-start-client.ts';
import { readChatFacts } from './chat-summary.ts';
import { BudgetAdmissionRejected, TurnAdmissionRejected, turnCommand } from './turns.ts';
import { ReportRejected } from './reports.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type Options = { store: EventStore; silo: string; childStartUrl?: string };
type Computer = { computerId: string; assistantId: string; generation?: number };
type Report = Omit<Parameters<typeof turnCommand>[2], 'status'> & { type: string };
type Context = Parameters<typeof turnCommand>[1];
type Stage = Awaited<ReturnType<typeof childRequestStage>>;

export async function checkedReportStage(options: Options, report: Report): Promise<Stage> {
  if (report.type !== 'agent.turn_started') return 'legacy';
  const facts = await readChatFacts(options.store, options.silo,
    report.conversationId, report.turnId);
  const stage = await childRequestStage(options, facts.created);
  if (stage === 'held' || (stage === 'activated' && !options.childStartUrl)) {
    throw new ReportRejected('Child request queued');
  }
  return stage;
}

export async function admitBridgeTurn(options: Options, computer: Computer,
  context: Context, report: Report, status: Parameters<typeof turnCommand>[2]['status'],
  replay: boolean, stage: Stage, tokens: Tokens | undefined,
  acknowledgement: { refused?: string; retryable?: boolean }) {
  if (status === 'started' && stage === 'activated') {
    if (!tokens) {
      acknowledgement.retryable = true;
      return undefined;
    }
    const child = await requestChildStart(options, computer, report, tokens);
    if (child.status === 'admitted') return child.binding;
    if (child.status === 'retryable') acknowledgement.retryable = true;
    else acknowledgement.refused = 'Child start unavailable';
    return undefined;
  }
  try {
    return await turnCommand(options.store, context, { ...report, status, replay });
  } catch (error) {
    if (error instanceof BudgetAdmissionRejected) {
      const refused = { silo: options.silo, assistantId: computer.assistantId,
        conversationId: report.conversationId, turnId: report.turnId, stopId: error.stopId };
      await recordBudgetRefusal(options.store, refused);
    }
    if (error instanceof TurnAdmissionRejected) {
      acknowledgement.refused = error.message;
    } else {
      acknowledgement.refused = routineStartRefusal(report, error);
    }
    return undefined;
  }
}
