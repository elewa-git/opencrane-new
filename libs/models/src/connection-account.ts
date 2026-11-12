import type { connectionCreatedDataSchema, connectionSelectedDataSchema } from '@opencrane/events';
import type { z } from 'zod';

type Activation = NonNullable<z.infer<typeof connectionCreatedDataSchema>['activation']>;

export function connectionAccount(activation: Activation) {
  if (activation.reason === 'oauth_confirmed') return activation.account;
  return verifiedBearerAccount(activation);
}

export function sameAccountIdentity(first: { issuer: string; subject: string },
  second: { issuer: string; subject: string }) {
  return first.issuer === second.issuer && first.subject === second.subject;
}

type Saved = z.infer<typeof connectionCreatedDataSchema> & { activation: Activation };
type Selection = Extract<z.infer<typeof connectionSelectedDataSchema>, { action: 'select' }>;

export function selectedProfileMatches(saved: Saved, selection: Selection) {
  return saved.userId === selection.userId && saved.serverId === selection.serverId &&
    saved.profile === selection.profileId && saved.activation.connectionId === selection.connectionId;
}

export function verifiedBearerAccount(activation: Activation) {
  if (activation.reason === 'oauth_confirmed') return undefined;
  return activation.verification?.account;
}

export function sameSavedAccount(before: Activation | undefined, after: Activation) {
  const original = before && connectionAccount(before);
  const replacement = connectionAccount(after);
  return !original || !replacement || sameAccountIdentity(original, replacement);
}
