import type { EventStore } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import { toolCredentialReleaseSchema } from '@opencrane/events';
import type { z } from 'zod';
import type { connectionCustody } from './connection-custody.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { credentialBroker } from './credential-broker.ts';

export interface PersonalCredentialDispatch {
  db: Pick<Db, 'lock'>;
  custody: Pick<ReturnType<typeof connectionCustody>, 'readAccessMaterial'>;
  loadConfiguration: OAuthConfigurationLoader;
}

type Release = z.infer<typeof toolCredentialReleaseSchema>;

/** Send one selected credential only after the broker saves its release. */
export async function sendPersonalCredential(store: EventStore, silo: string,
  dispatch: PersonalCredentialDispatch, decisionId: string, release: Release,
  deadline: number, confirmAccess: () => Promise<void>,
  sendAccess: (material: string) => Promise<void>) {
  const context = toolCredentialReleaseSchema.pick({
    requestId: true, permitId: true, userId: true, assistantId: true,
    computerId: true, computerGeneration: true, conversationId: true,
    turnId: true, threadId: true, serverId: true, toolName: true,
    argumentsDigest: true, purpose: true,
  }).strip().parse(release);
  function prepareAccess() {
    const access = { deadline: Math.min(deadline, performance.now() + 2000),
      checkAccess: confirmAccess };
    return Promise.resolve(access);
  }
  const broker = credentialBroker(store, dispatch.db, dispatch.custody, silo,
    decisionId, context, dispatch.loadConfiguration, prepareAccess, sendAccess);
  await broker.send();
}
