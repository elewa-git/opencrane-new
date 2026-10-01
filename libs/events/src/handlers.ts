// Named subscriptions from the event catalogue. An implementation is enabled
// only when its host registers it; this does not enable the future reactions.
export const handlerSubscriptions = {
  "update-members": [
    "member.invited",
    "member.joined",
    "member.role_changed",
    "member.removed",
  ],
  "update-openfga": [
    "member.joined",
    "member.role_changed",
    "member.removed",
    "team.created",
    "team.member_added",
    "team.member_removed",
    "assistant.created",
    "conversation.created",
    "participant.added",
    "participant.removed",
    "grant.given",
    "grant.revoked",
  ],
} as const;
export type HandlerName = keyof typeof handlerSubscriptions;
