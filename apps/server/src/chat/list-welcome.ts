import { readSurvey } from '@opencrane/projections';
import { ChatAccessApplying, type ChatOptions } from './access.ts';

export async function welcomeListChoice(options: ChatOptions, memberId: string) {
  const currentPosition = await options.store.head(`personal-${memberId}`,
    performance.now() + 10_000);
  if (currentPosition === 0) return null;
  const personal = await readSurvey(options.db, options.silo, memberId);
  if (currentPosition !== (personal?.position ?? 0)) {
    const changed = await unprojectedWelcomeChange(options, memberId,
      personal?.position ?? 0, currentPosition);
    if (changed) throw new ChatAccessApplying();
  }
  const welcome = personal?.welcome;
  if (!welcome || welcome.status !== 'completed' ||
      !welcome.completedAt || !welcome.completionPosition) return null;
  const archived = welcome.archived ?? false;
  const archivePosition = welcome.archivePosition ?? 0;
  const row = { kind: 'welcome' as const, welcomeId: welcome.welcomeId,
    route: '/welcome', title: 'Welcome', createdAt: welcome.startedAt,
    activityAt: welcome.completedAt, unread: 0, archived, archivePosition };
  const position: [number, number] = [welcome.completionPosition, welcome.completionPosition];
  const revision = [welcome.welcomeId, welcome.completionPosition, archivePosition, archived];
  return { row, position, archived, revision: JSON.stringify(revision) };
}

async function unprojectedWelcomeChange(options: ChatOptions, memberId: string,
  projectedPosition: number, currentPosition: number) {
  const deadline = performance.now() + 10_000;
  for await (const row of options.store.readStream(`personal-${memberId}`,
    projectedPosition + 1, deadline)) {
    if (row.sequence > currentPosition) break;
    if (row.event.type === 'onboarding.completed' ||
        row.event.type === 'onboarding.welcome_archive_set') return true;
  }
  // Let unrelated survey and persona saves leave the completed list row readable.
  return false;
}
