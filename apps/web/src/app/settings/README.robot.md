# Personal settings contracts

For people, read [README.md](README.md) first.

`account-screen.*` reads `/auth/me` and `/api/onboarding`. It shows the
session name as read-only and offers `/welcome/survey` only for an unfinished
survey. `personal-settings-shell.*` renders desktop navigation and the phone
menu. `pages.ts` names Account, Preferences, Assistant and My tools routes.

The Assistant page links to `/welcome/persona`. That screen checks four saved
survey steps and the current revision before offering approval. The Assistant
page itself still has no assignment or editing controls. Account does not show
email, organisation, role, groups or an editable preferred name yet.
