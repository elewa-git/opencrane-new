# Fresh organisation journey details

The journey extends `infra/dev-stack/journey.ts` with
`infra/dev-stack/browser-phase4.ts`. The existing journey signs in the owner and
member first. This check uses those same pages and the local model stub.

It checks group list, search, creation, detail and member removal after a review.
The seeded member is added through the authenticated group command because the
member picker is not available. A model grant is added to the disposable event
store so the owner can create a shared assistant and the member can start a private
session with it.

It starts a direct chat between the seeded member and owner, sends one message from
each person and checks the saved message order. The stub's `/journey-counts` endpoint
counts model requests before and after that exchange. The conversation history
counts any other event as an assistant request.

It saves a fake provider key only. The check does not call a real provider and does
not test whether the key works. The provider status must still say that reachability
and a model answer have not been checked.

Every assertion appears in `README.md` and in each run's JSON receipt. Screenshots
are saved in `run-1/` and `run-2/`. Ownership transfer is `NOT PROVEN` unless PR #262
has merged. Separate member disks and browser profiles are `NOT PROVEN` because they
are not built. A real provider answer is `PAID / NOT RUN` because it needs a paid call.
