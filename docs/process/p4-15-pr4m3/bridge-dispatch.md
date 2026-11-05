# Recall bridge dispatch

5 November 2026. Part of #97. This split follows the server preparation work.
Base: `d3205b75a6eafe9bd1974e4be889f6058efe91cd` (#875).
Prerequisites are merged: #870 at `34da39127b23e26e2457b57c68957769efc303fa`
and #871 at `6031183ebb29f8023edf914adb04913a58088884`.

## Scope

Qualified personal turns offer only reviewed, free Allow recall. The server binds a pending recall to the original offered turn and saved admission.
It sends checked definitions over the authenticated bridge. Discovery must complete
before initial input or credentials are released. Access, policy, qualification and
saved identity are checked again before and after signing credentials. Local caller
registrations stay separate on server and computer; neither crosses the wire.

The first test commit is `e66075b7d`. Its completed failing run reached native thread
creation, then failed because the server sent no load request.
Test commit `6dd76c8aa` then proved the normal sender omitted the recall offer.
Test commit `bca09b37d` proved an offered turn could be sent again before its native
thread or start reply arrived. The sender now keeps the original offer.
Test commit `4f84a56a9` reproduced a refusal when recall confirmation took over two
seconds. Moving it before the credential access check made the same test pass.

## Own checks

Checks use `nice -n 10`, one Vitest worker and no file parallelism. PostgreSQL is a
throwaway container on an assigned loopback port, with disposable NATS services.
Deployment measurements and IAM responses in the joined fixture are simulated.
The existing preparation suite separately uses disposable OpenFGA.

- PASS: clean `npm ci` and the requested tool symlinks.
- PASS: the joined successful dispatch and seven withdrawal/lost-reply cases.
- PASS: the first broader run, 690 tests across five files, including the unchanged
  460 security-rule cases. The new qualified-offer test passed separately.
- PASS: all 12 sender tests twice after the no-resend change.
- PASS: full typecheck and final server typechecks; `check:events` (158 event types).
- PASS: full lint, including Knip, documentation, links, fixtures, licences and changelog.
  ESLint reported zero errors and 35 existing size warnings. Focused final code lint passed.
- PASS: the final 243-test selection twice, before the timing correction.
- PARTIAL: two full-file repeats after that correction and pushed-head CI are running.
  The draft PR records their completed results.
- NOT RUN: full root suite, development stacks, paid calls or live qualification.

## Remaining work

PARTIAL: the real gateway/backend result proof remains.
The joined fixture supplies saved admission and exercises the production chat sender,
preparation, authenticated bridge, computer runner, loader, proxy and native discovery.
It proves the input and credential gate, not a real recall result or saved loaded evidence
before result bytes. The four-call, 64 KiB and 32-reference limits and gateway header
replacement are unchanged and are not exercised by this new fixture.

The unchanged preparation and computer tests cover receipt mutations and separate
same-user catalogues at their existing boundaries. This split does not claim every
condition has passed through the full server/computer/backend exchange. Global admission
remains disabled. Complete the remaining work before PR 4n. Native writes and shared
scope remain separate work. No new dependency or event type is introduced.
