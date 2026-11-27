# Personal settings contracts

For people, read [README.md](README.md) first.

`account-screen.*` reads `/auth/me` and `/api/onboarding`. It shows the
session name as read-only and offers `/welcome/survey` only for an unfinished
survey. `personal-settings-shell.*` renders desktop navigation and the phone
menu. `pages.ts` names Account, Preferences, Assistant and My tools routes.

`my-tools.*` reads `GET /api/my/tools` to show each registered server by name
and the member's status. Connect opens the key form for that server. Manage
connection opens the member's saved profiles, including after a grant is
removed. A chat link with `?serverId=<id>` opens the matching row when its
connection can be managed. Saving a choice or revoking a key refreshes the
tool statuses.

`ToolConnections` reads `GET /api/my/tools/:serverId/profiles` with 20 rows
per page. Profile rows contain safe profile ids and status. Selected is
shown separately and never means a grant. A blocked profile stays visible.
The page ignores a detail reply after another profile is chosen. It reads a
profile's safe detail before showing Revoke. The review names the tool and safe
profile id and explains the local effect and the provider limit. It sends one change reference and saved
profile revision. It saves the profile id and change reference in session storage
before POST, under `my-tools-revoke:<serverId>`. A return visit restores them.
A lost reply keeps that reference and only checks its original status. A 404
stays unknown and does not unlock another revoke. A refused read
clears rows, detail, review and pending reference before late replies can render.
`key-assistants.*` shows labelled checkboxes below each saved key. It reads the
current selection settings, the person’s assistant from `/api/chat` and shared
assistants from `/api/assistants`, keeping only those with `canStartSession`. With
no saved list it checks only the personal assistant. Editing requires the selected
key. It sends one ordinary selection command with `allowedAssistantIds` and the
current revision; it never sends an owner id. A lost reply keeps only its original
change reference under `key-assistants:<serverId>` and offers a status GET. A conflict
reloads the saved list and selected profile before another edit. A stale row cannot
select its old key by editing consent. Page Refresh reloads the consent panels as well
as profile rows. Confirmed consent saves update the selection revision locally;
they do not refresh the profile inventory. Original receipt checks reload only consent.
Definite input and body-size refusals clear the unpublished change
reference; uncertain outcomes still require the original receipt. Failed reads, writes
and receipt checks report only fixed operation and cause categories to the browser
console. They never log exception messages, account fields or response bodies.
Connect opens `personal-key.*` on the same page.
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
