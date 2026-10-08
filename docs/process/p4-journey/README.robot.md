# Fresh organisation journey details

The browser check lives in `infra/dev-stack/browser-phase4.ts` and runs from
`infra/dev-stack/journey.ts`. It runs only when the stack is secondary and the
journey has real signed-in browser sessions, and `P4_JOURNEY_ATTEMPT` names the
run. The owner stack, daily fresh run and runs without a browser do not run these
checks.

The check creates a group through the group page, adds the seeded member through
`POST /api/groups/:groupId`, and removes that member through the reviewed group
screen. The server has no command for granting a model to a group, so the check
adds that one event to the disposable stack event store. It creates a shared
assistant through its server command, starts a private session through the
member page, and waits for the local model stub's reply before saving screenshots.

The check creates a new group, assistant, provider and direct conversation on
every run. Receipts and screenshots first live under
`$DEV_STACK_DIR/p4-journey/<attempt>/`. Copy them into this folder only after
the run has been recorded. The receipt includes the commit and the measured
Phase 4 run time.

Ownership transfer is attempted only on a secondary stack. The server accepts
that command only from a current Owner. The Zitadel test account is an Admin,
so the check records `NOT PROVEN` and does not add an ownership event to make
the account an Owner. Separate member disks and a paid provider answer remain
`NOT PROVEN` and `PAID / NOT RUN` respectively.
