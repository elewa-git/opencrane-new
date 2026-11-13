import type { EventStore } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import type { toolCredentialReleaseSchema } from '@opencrane/events';
import type { z } from 'zod';
import type { connectionCustody } from './connection-custody.ts';
import type { OAuthConfigurationLoader } from './oauth-selection.ts';
import { credentialBroker, credentialBrokerContext } from './credential-broker.ts';

export interface PersonalCredentialDispatch {
  db: Pick<Db, 'lock'>;
  custody: Pick<ReturnType<typeof connectionCustody>, 'readAccessMaterial'>;
  loadConfiguration: OAuthConfigurationLoader;
}

type Release = z.infer<typeof toolCredentialReleaseSchema>;

export interface PersonalCredentialRequest {
  decisionId: string;
  release: Release;
  deadline: number;
  confirmAccess: () => Promise<void>;
  sendAccess: (material: string) => Promise<void>;
}

/** Prepare this request's saved evidence before the shared budget queue. */
export async function preparePersonalCredential(store: EventStore, silo: string,
  dispatch: PersonalCredentialDispatch, request: PersonalCredentialRequest) {
  const { decisionId, release, deadline, confirmAccess, sendAccess } = request;
  const context = credentialBrokerContext(release);
  function prepareAccess() {
    const access = { deadline: Math.min(deadline, performance.now() + 2000),
      checkAccess: confirmAccess };
    return Promise.resolve(access);
  }
  const broker = credentialBroker(store, dispatch.db, dispatch.custody, silo,
    decisionId, context, dispatch.loadConfiguration, prepareAccess, sendAccess);
  await broker.prepare();
  return broker.send;
}
