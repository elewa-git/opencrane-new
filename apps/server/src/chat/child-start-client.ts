import { z } from 'zod';
import { computerTokenAudience, type tokenIssuer } from '@opencrane/auth';
import { readyBridgePass } from './bridge-control.ts';
import type { turnCommand } from './turns.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type Options = Parameters<typeof readyBridgePass>[0] & { childStartUrl?: string };
type Computer = { computerId: string; assistantId: string;
  generation?: number | undefined };
type Report = { conversationId: string; turnId: string; threadId?: string | undefined };
type ChildStartResult =
  | { status: 'admitted'; binding: NonNullable<Awaited<ReturnType<typeof turnCommand>>> }
  | { status: 'retryable' }
  | { status: 'refused' };
const admittedChild = z.object({
  conversationId: z.string(), turnId: z.string(), threadId: z.string(),
  requesterId: z.string(), payingGroupId: z.string(), rootId: z.string(),
  task: z.literal('chat_turn'), executionMode: z.literal('restricted'),
  sharingClass: z.literal('shared_only'), model: z.string().optional(),
  providerId: z.string().optional(), bindingSequence: z.number().int().optional(),
});

export async function requestChildStart(options: Options, computer: Computer,
  report: Report, tokens: Tokens): Promise<ChildStartResult> {
  if (!options.childStartUrl || !report.threadId || computer.generation === undefined) {
    return { status: 'refused' };
  }
  try {
    const pass = await readyBridgePass(options, computer, tokens);
    const claims = await tokens.verify(pass.value, computerTokenAudience);
    if (claims['generation'] !== computer.generation) return { status: 'refused' };
    const body = { conversationId: report.conversationId, turnId: report.turnId,
      threadId: report.threadId };
    const response = await fetch(`${options.childStartUrl}/child-start`, {
      method: 'POST', headers: { authorization: `Bearer ${pass.value}`,
        'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 500) return { status: 'retryable' };
    if (!response.ok) return { status: 'refused' };
    const parsed = admittedChild.safeParse(await response.json());
    if (!parsed.success) return { status: 'retryable' };
    return { status: 'admitted', binding: parsed.data };
  } catch {
    // A lost reply cannot prove whether the saved start was accepted. Retry its original ids.
    return { status: 'retryable' };
  }
}
