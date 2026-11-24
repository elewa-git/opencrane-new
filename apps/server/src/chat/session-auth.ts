import { isOrganisationSession, type AuthConfig, type SessionData } from '@opencrane/auth';
import type { ChatOptions } from './access.ts';

export function validChatSession(session: SessionData, config: AuthConfig, options: ChatOptions) {
  return isOrganisationSession(config, session) && session.exp * 1000 > Date.now() &&
    options.silo === options.binding.silo;
}
