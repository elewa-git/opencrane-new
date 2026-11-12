# Packaged file uploads

Journey on a fresh dev stack: NOT RUN

Recorded on 12 November 2026 for issue #15, slice 1 of 3.
The browser journey is a merge condition. Component checks do not satisfy it.

## Observed steps

1. Checked `origin/main` and open pull requests before starting. This slice was
   neither merged nor open. Read the issue's owner decisions and Slices comment.
2. Ran `npm ci` and linked the existing NATS and link-checking tools.
3. Built the application, object-store and scanner images. Verified a fresh scanner
   release against its three actual databases and independently approved manifest.
4. Ran the source gates below, then claimed secondary slot **1** through `claim.sh`.
5. Ran the standard `journey-entry.ts` guard with that claimed id. It refused:
   **Automated journeys require a secondary stack and no fleet task**.
   `requireAutomatedJourney` rejects the inherited `OPENCRANE_FLEET_TASK` setting.
   The setting was preserved and the guard was not bypassed.
6. Ran `run.sh package-down --id 1` and `down.sh --id 1`. Both exited zero.

No packaged namespace or installation was created. `package-prepare`, private
preparation, `package-up`, `package-check` and browser sign-in were **NOT RUN**
after the guard refusal. Neither the owner stack nor its ports were used.

A separate image publication attempt through the existing loopback registry failed
with **connection reset by peer**. The reviewed images exist locally; their presence
in the registry and their installation on Kubernetes have not been proved.

## Browser acceptance still required

| Width | Signed-in clean upload and answer | EICAR refusal | Screenshot |
| --- | --- | --- | --- |
| 1280 px | NOT RUN | NOT RUN | Not taken |
| 390 px | NOT RUN | NOT RUN | Not taken |

After the guard and registry permit qualification, use a newly claimed secondary
slot and a fresh packaged installation in the order documented in
[the dev-stack contract](../../../infra/dev-stack/README.robot.md).
Use a newly reviewed scanner release if the recorded database check has expired.
At each width, sign in, start a chat, choose a small text or PDF file through Attach,
wait for Ready, and ask for a fact present only in that file. Save the chat answer.
Then choose the EICAR test file and save the visible
**File refused: malware detected.** message. Always run package-down and down.

## Own checks

| Check | Result |
| --- | --- |
| Scanner, HTTPS service, release and real storage fixtures: 154 tests | PASS twice |
| Chart, upload services, rendering and preflight: 318 tests | PASS twice |
| Installer and private-setting refusals: 269 tests | PASS twice |
| Database backup chart compatibility: 207 tests | PASS twice |
| Licence and promotion checks: 82 tests | PASS twice |
| Actual application image layers, imports and native hashes: 11 tests | PASS twice |
| Root workspace and infrastructure typecheck | PASS |
| `check:events`: 174 catalogue entries | PASS |
| Knip | PASS |
| Changelog lint | PASS |
| ESLint on changed files | PASS |
| Additional ESLint on infrastructure JavaScript ignored by the root config | PASS |
| Markdown lint | PASS |
| Public privacy and secret scans | PASS |
| Actual all-layer image scan and source-bound licence promotion | PASS |
| Browser journey on a fresh packaged installation | NOT RUN |

Tests, typecheck, lint and builds ran under `nice -n 10`. Vitest used two workers.
No full root test suite ran. No application web source changed; the actual package
image build compiled the website. Infrastructure TypeScript remains ignored by the
repository's ESLint configuration and is covered here by its strict typecheck.

The production packaged adapter was also exercised inside the built application
image against the pinned ClamAV engine in an isolated Docker network namespace.
It verified the mounted database bytes before returning **clean** for small text
and **infected** for EICAR. This was a component check, without a browser or chat.
Its disposable container was removed. The real MinIO fixture verified short-lived
leases, renewal, object access and refusal of another bucket and bucket creation.

## Image records

The application image was built from committed source
`ba0654ee70d618708299cdc0a03a81e4768d4494`. Later commits change chart delivery,
reviewed image records, test fixtures and this receipt. They change no application
runtime module copied into that image.

- Application image: `sha256:c93724caa47d73214dd9bc0cd9261a17245941a4d4da126cdb143acd8f70fca7`.
- Scanner image: `sha256:126d7e9292b6c260c60d4fc945bb74698ddd387da474b73bca78d3b0ad2becfb`.
- Object-store image: `sha256:adf12617265bc7ff63369b81854605493964424a90d9e713c14ae62a8cd3e31c`.

The inventory covers 580 application-image components, 243 object-store components
and 112 scanner operating-system packages. The scanner's GPL engine and bundled
notices are recorded separately. Signed Debian main indexes cover every installed
OS package. The image inventory also records the reviewed CC0 hashing library
bundled inside AGPL MinIO, as allowed by the runtime-layer policy.

## Work log and cleanup

Started with failing tests for package services and source-bound image promotion.
A real image check then exposed hidden shell files in the upstream scanner database
folder. Removed that folder before copying the exact reviewed database set.
Pinned loaded scanner facts before cleaning up shared code. Reproduced and fixed
Kubernetes delivery of Secret files and numeric non-root engine identity.

Shared the bounded ClamAV transport, release validation and fixed production engine
settings. Deleted the duplicate development transport. Split model runtime settings
from private package preparation. Historical licence fixtures now use a fixed
baseline and explicit unreviewed inputs, so later promotion cannot rewrite their
claims. No event, business-state or access-check contract changed.

The change has **817 changed shipped-code and configuration lines** (additions plus
removals), excluding tests, documentation and generated licence/release records.
This includes the two dependency declaration lines. The root declaration reuses the
already installed Apache-2.0 MinIO client for the real storage test.
The worktree is retained for review. The claimed slot and disposable test containers
were released; the existing shared registry and test database were left in place.
