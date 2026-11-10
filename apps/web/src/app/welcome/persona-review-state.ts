export type ReviewState = 'loading' | 'generating' | 'generation_unknown' | 'ready'
  | 'absent' | 'stale' | 'saving' | 'unknown'
  | 'unavailable' | 'signed_out' | 'refused' | 'approved' | 'editing' | 'edit_conflict'
  | 'edit_saving' | 'edit_unknown' | 'restart_review' | 'restarting'
  | 'restart_unknown' | 'restarted' | 'no_assistant';

export type PendingKind = 'generation' | 'edit' | 'restart' | 'approve';
export const pendingStates: Record<PendingKind, { busy: ReviewState; unknown: ReviewState }> = {
  generation: { busy: 'generating', unknown: 'generation_unknown' },
  edit: { busy: 'edit_saving', unknown: 'edit_unknown' },
  restart: { busy: 'restarting', unknown: 'restart_unknown' },
  approve: { busy: 'saving', unknown: 'unknown' },
};
