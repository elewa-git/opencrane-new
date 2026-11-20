import type { ChatContext } from '@opencrane/protocol';
import { memberAuthorisation } from '@opencrane/authz';
import type { ChatOptions } from './access.ts';
import { memoryAdmission } from './memory-admission.ts';

export async function personalContext(options: ChatOptions, memberId: string) {
  const result = await options.db.query<{ assistant_id: string }>(
    "SELECT assistant_id FROM computers WHERE silo = $1 AND owner_id = $2 AND kind = 'personal'",
    [options.silo, memberId]);
  const member = await options.db.query<{ display_name: string | null; role: ChatContext['role'] }>(
    'SELECT display_name, role FROM members WHERE silo = $1 AND member_id = $2', [options.silo, memberId]);
  let assistantId: string | null = result.rows[0]?.assistant_id ?? null;
  if (assistantId) {
    const permission = await memberAuthorisation(options.binding).actsFor(memberId, assistantId);
    if (!permission.allowed) assistantId = null;
  }
  return { memberId, displayName: member.rows[0]?.display_name ?? null, assistantId,
    role: member.rows[0]?.role, memoryAdmission, personalConnections: true };
}
