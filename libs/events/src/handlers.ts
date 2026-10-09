// Named subscriptions from the event catalogue. An implementation is enabled
// only when its host registers it; this does not enable the future reactions.
export const handlerSubscriptions = {
  "settle-budget": ["effect.observed", "effect.resolved", "computer.lost"],
  "update-members": [
    "member.invited",
    "member.joined", "silo.owner_bootstrapped",
    "member.role_changed",
    "member.removed",
    "ownership.seeded", "ownership.transferred", "ownership.stepped_down",
  ],
  "update-openfga": [
    "provider.created",
    "member.joined", "silo.owner_bootstrapped",
    "member.role_changed",
    "member.removed",
    "ownership.seeded", "ownership.transferred", "ownership.stepped_down",
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
  "seed-ownership": ["silo.owner_bootstrapped"],
  "seed-provider-default": ["provider.verification_recorded", "provider.models_selected"],
  "seed-model-grants": ["member.joined", "silo.owner_bootstrapped", "assistant.created"],
  "create-assistant": ["member.joined", "silo.owner_bootstrapped"],
  "claim-computer": ["assistant.created", "computer.lost"],
} as const;
export type HandlerName = keyof typeof handlerSubscriptions;
