# Personal settings contracts

For people, read [README.md](README.md) first.

`account-screen.*` reads `/auth/me` and `/api/onboarding`. It shows the
session name as read-only and offers `/welcome/survey` only for an unfinished
survey. `personal-settings-shell.*` renders desktop navigation and the phone
menu. `pages.ts` names Account, Preferences, Assistant and My tools routes.

`my-tools.*` reads `GET /api/my/tools/:serverId/profiles` with 20 rows per page.
`/account/tools?serverId=<id>` supplies the server id. The server currently has
no member-facing catalogue of integrations, so the bare settings link asks for
an integration ID. Rows contain safe profile ids and status only. They do
not contain verified provider names, scopes, expiry or secrets. Selected is
shown separately and never means a grant. A blocked profile stays visible.
The page ignores a detail reply after another profile is chosen. It reads a
profile's safe detail before showing Revoke. The review names its safe profile
and integration ids and explains
the local effect and the provider limit. It sends one change reference and saved
profile revision. It saves the profile id and change reference in session storage
before POST, under `my-tools-revoke:<serverId>`. A return visit restores them.
A lost reply keeps that reference and only checks its original status. A 404
stays unknown and does not unlock another revoke. A refused read
clears rows, detail, review and pending reference before late replies can render.
The Connect or choose a key action opens `personal-key.*` on the same page.
It loads the reviewed connection settings, accepts a password input and clears it
before waiting for POST. A successful own-profile read shows the verified account.
Use this key calls the existing explicit selection command. Lost save or selection
replies retain only a profile id, change reference and operation kind under
`personal-key:<serverId>`; Check status never resends. Input is also cleared on access
loss, server change and destruction. No key is read back or stored in the browser.
The [personal-key API](../../../../../docs/api/personal-keys.md) defines the contract.
`npm run visual:screen-p3-8-bearer` uses intercepted replies at both widths.

The Assistant page links to `/welcome/persona`. That screen checks four saved
survey steps and the current revision before offering approval. The Assistant
page itself still has no assignment or editing controls. Account does not show
email, organisation, role, groups or an editable preferred name yet.
