import { personalKeyCommandSchema } from '@opencrane/protocol';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Db } from '@opencrane/projections';
import type { connectionCustody } from './connection-custody.ts';
import type { RemoteNetwork } from './remote-https.ts';
import { saveBearerConnection } from './bearer-connections.ts';
import { verifyBearerIdentity } from './bearer-identity.ts';
import { requirePersonalConnectionAccess } from './connection-selection.ts';
import { toolPolicyFromRows } from './tool-policy.ts';

export interface PersonalKeyDependencies {
  custody: Pick<ReturnType<typeof connectionCustody>, 'stage'>;
  db: Pick<Db, 'lock'>;
  network?: RemoteNetwork;
}
export interface PersonalKeySaveInput {
  command: unknown;
  material: string;
}

/** Check access and identity inside the existing save's profile lock, before staging a key. */
export function savePersonalKey(store: EventStore, binding: Binding, memberId: string,
  dependencies: PersonalKeyDependencies, input: PersonalKeySaveInput) {
  let serverId: string | undefined;
  async function verifyIdentity(rows: StoredEvent[], material: string) {
    const policy = toolPolicyFromRows(rows);
    if (!policy.serverId || !policy.identityTool) throw new Error('Identity check unavailable');
    serverId = policy.serverId;
    await requirePersonalConnectionAccess(store, binding, memberId, policy.serverId);
    return verifyBearerIdentity({ rows, material,
      ...(dependencies.network ? { network: dependencies.network } : {}) });
  }
  async function confirmAccess() {
    if (!serverId) throw new Error('Connection access unavailable');
    const fresh = await requirePersonalConnectionAccess(store, binding, memberId, serverId, true);
    if (!fresh) throw new Error('Connection access unavailable');
    return fresh;
  }
  personalKeyCommandSchema.shape.material.parse(input.material);
  const stage = dependencies.custody.stage.bind(dependencies.custody);
  const custody = { stage, verifyIdentity, confirmAccess };
  return saveBearerConnection(store, binding, memberId, custody, input.command,
    input.material, dependencies.db);
}
