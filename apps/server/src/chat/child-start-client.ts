import { z } from 'zod';
import { computerTokenAudience, type tokenIssuer } from '@opencrane/auth';
import { readyBridgePass } from './bridge-control.ts';
import type { turnCommand } from './turns.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type Options = Parameters<typeof readyBridgePass>[0] & { childStartUrl?: string };
type Computer = { computerId: string; assistantId: string;
  generation?: number | undefined };
type Report = { conversationId: string; turnId: string; threadId?: string | undefined };
const admittedChild = z.object({
  conversationId: z.string(), turnId: z.string(), threadId: z.string(),
  requesterId: z.string(), payingGroupId: z.string(), rootId: z.string(),
  task: z.literal('chat_turn'), executionMode: z.literal('restricted'),
  sharingClass: z.literal('shared_only'), model: z.string().optional(),
  providerId: z.string().optional(), bindingSequence: z.number().int().optional(),
});

export async function requestChildStart(options: Options, computer: Computer,
  report: Report, tokens: Tokens): Promise<NonNullable<Awaited<ReturnType<typeof turnCommand>>>> {
  if (!options.childStartUrl || !report.threadId || computer.generation === undefined) {
    throw new Error('Child start unavailable');
  }
  const pass = await readyBridgePass(options, computer, tokens);
  const claims = await tokens.verify(pass.value, computerTokenAudience);
  if (claims['generation'] !== computer.generation) throw new Error('Child start unavailable');
  const body = { conversationId: report.conversationId, turnId: report.turnId,
    threadId: report.threadId };
  const response = await fetch(`${options.childStartUrl}/child-start`, {
    method: 'POST', headers: { authorization: `Bearer ${pass.value}`,
      'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Child start unavailable');
  return admittedChild.parse(await response.json());
}
