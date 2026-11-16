import { z } from 'zod';
import { sessionAssistantSchema, sessionConfiguration } from '@opencrane/events';
import { memberAuthorisation } from '@opencrane/authz';
import { PayingGroupRefused } from '@opencrane/models';
import { ChatRefused, type ChatOptions } from './access.ts';
import { creationEvent } from './private-session.ts';

const selectedAssistantFields = sessionAssistantSchema.pick({ kind: true, payingGroupId: true });
const assistantDetails = selectedAssistantFields.extend({ kind: z.string() });

export async function assistantCreationDetails(options: ChatOptions, memberId: string,
  input: { assistantId: string; payingGroupId?: string | undefined }, deadline?: number) {
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.actsFor(memberId, input.assistantId);
  if (!permission.allowed) throw new ChatRefused('Assistant refused');
  const assistant = await creationEvent(options.store, options.silo,
    `assistant-${input.assistantId}`, 'assistant.created', deadline);
  const details = assistantDetails.parse(assistant.data);
  const configuration = sessionConfiguration({ conversation: input, assistantKind: details.kind,
    assistantPayingGroupId: details.payingGroupId, memoryEnabled: false });
  if (configuration.assistantPayerRequired && !configuration.payerMatchesAssistant) {
    throw new PayingGroupRefused('Paying group must match the assistant');
  }
  return details;
}
