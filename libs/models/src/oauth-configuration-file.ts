import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { oauthConfigurationSchema } from './oauth-attempt.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);

/** Read current operator settings on each check so a changed file closes old calls. */
export function oauthConfigurationFromFile(filename: string | undefined) {
  return async function loadConfiguration(serverId: string) {
    identifier.parse(serverId);
    if (!filename) throw new Error('OAuth configuration unavailable');
    try {
      const raw = await readFile(filename, 'utf8');
      const configurations: unknown = JSON.parse(raw);
      const records = z.record(identifier, z.unknown()).parse(configurations);
      return oauthConfigurationSchema.parse(records[serverId]);
    } catch {
      throw new Error('OAuth configuration unavailable');
    }
  };
}
