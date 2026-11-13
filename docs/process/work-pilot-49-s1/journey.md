# Personal tool keys: browser receipt

Journey on a fresh dev stack: PASS — 13 November 2026, at 1280 px and 390 px.

Tested rebased product head: `500201a08b4b6953411167347edc42a2ee756f55`.
The following commit adds only this receipt and its evidence. The pictures from
12 November remain historical; the links below point to this new run.

## Setup and rebase

Continued the existing rebase onto `cb369e593`. Kept main's upload journey files
and composer upload flow, retained this slice's personal-key additions and the
44 px attachment controls. No product repair was made during qualification.
The lockfile did not change, so dependency installation was not repeated.

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, then ran
`infra/dev-stack/up.sh --fresh` with the existing setup credential referenced by
path. Kept the fleet guard enabled. The complete startup qualification passed,
including upload and live view at both widths. See the [startup results](run-2026-11-13/startup.md).

Used real single sign-on and product controls against that slot. The demo ran in
its existing credential-checked mode with synthetic accounts held outside the
repository. Its guarded local TLS transport reached the actual demo server. The
free model called the real tool and quoted its returned account. Browser API
responses were not replaced. Member B had no personal assistant and used the
existing shared assistant. Test membership was prepared through events and a
product group command.

## Observed journey

1. PASS: the admin entered the remote demo address, checked the original discovery
   status and continued to tools and access. They allowed the read and identity
   tools, blocked the write tool, and saved grants for the people and assistants.
   They selected **Needs a personal key** and read-only `who_am_i`, then confirmed
   publication. The current publication was ready. Review and publication pictures
   were captured at both widths.
2. PASS at both widths: member A submitted an invalid key. The server returned
   422, the page showed **Identity not verified**, and the key input was empty.
   The first refusal left no saved connection. The phone refusal did not replace
   the existing verified selection.
3. PASS at both widths: A saved the valid key, saw **Verified as account-a**, chose
   **Use this key**, and returned to My tools. The saved profile was verified and
   selected; its details still named account A, and the key form was empty.
   Immediately after the desktop selection, the collector did not see the selected
   row. The return visit displayed the saved selection without another save or
   selection request.
4. PASS at both widths: A started a fresh personal session and sent a live read
   request. `read_fixture_quote` completed. The answer reported **Acted as account-a**
   and **Recorded effects: 0**.
5. PASS at both widths: B started a shared-assistant session without a saved key.
   B completed a normal turn, saw the missing-key notice afterwards, and followed
   **Connect your key in My tools**. That page showed no saved connections and an
   empty key form. The browser did not inspect the model's offered tool list;
   exclusion of this server's tools is covered by the product-command tests.
6. PASS: the normal live catalogue check at 14:48:12 UTC, after both live tool turns,
   retained `accountMode: personal`, `identityTool: who_am_i`, publication and no
   drift hold. See the [readback](run-2026-11-13/catalogue.json). Replay retention
   was checked by the changed product-command tests, rather than a live rebuild
   during these browser steps.

Collector corrections used visible labels and original status reads. They did not
change product code or resend an installation, saved key or selection command.

## Screenshots from this head

All key inputs were checked to be empty before capture. Email text was masked.
Both widths fit without horizontal scrolling.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Admin review | [Review](run-2026-11-13/review-1280.png) | [Review](run-2026-11-13/review-390.png) |
| Publication ready | [Published](run-2026-11-13/published-1280.png) | [Published](run-2026-11-13/published-390.png) |
| Invalid-key refusal | [Refusal](run-2026-11-13/identity-refused-1280.png) | [Refusal](run-2026-11-13/identity-refused-390.png) |
| Key verified | [Verified](run-2026-11-13/key-verified-1280.png) | [Verified](run-2026-11-13/key-verified-390.png) |
| Verified and selected on return | [Selected](run-2026-11-13/selected-account-1280.png) | [Selected](run-2026-11-13/selected-account-390.png) |
| Empty form on return | [Form](run-2026-11-13/key-return-1280.png) | [Form](run-2026-11-13/key-return-390.png) |
| A's live tool result | [Account A](run-2026-11-13/account-a-turn-1280.png) | [Account A](run-2026-11-13/account-a-turn-390.png) |
| B's completed turn and notice | [Missing key](run-2026-11-13/missing-key-1280.png) | [Missing key](run-2026-11-13/missing-key-390.png) |
| B's linked empty form | [No saved key](run-2026-11-13/no-saved-key-1280.png) | [No saved key](run-2026-11-13/no-saved-key-390.png) |

## Own source checks after rebase

- PASS: the PR's changed tests ran once under `nice -n 10`: 651 server, demo and
  model tests in 10 files; 142 web tests in three files; and 111 dev-stack Node tests.
  Database fixtures used the shared disposable test database. No full root suite ran.
- PASS: workspace, package and dev-stack typecheck; event catalogue, 174 types;
  Knip; changelog lint; and changed-file ESLint. Knip retained two configuration
  hints. ESLint reported the existing `mcpDispatch` size warning and warnings for
  ignored fixture files, with no errors.
- PASS: Markdown lint, public privacy check and secret scan before pushing.
- NOT RUN: an external provider, paid model, company-account turns or personal
  assistant restrictions. These are outside this slice's journey.

## Cleanup

PASS: closed the browsers, stopped the local demo fixture and ran
`infra/dev-stack/down.sh` for claimed slot 1. Shutdown returned zero and removed
the slot directory. Kept this worktree for review.
