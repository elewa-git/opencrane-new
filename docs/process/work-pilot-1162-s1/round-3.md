# Final bootstrap and operator evidence fixes

Date: 23 November 2026. Branch: `work/pilot-1162-s1`.
Implementation: `3e81aa979`, following failing-first commits `cda659ef3` and `dde244dce`.

## Findings and failing-first evidence

1. Unsafe default: the [focused red run](logs/round-3/flags-red.txt) failed all three
   selected tests. No-argument execution invoked a mutating host command, explicit
   apply was unknown and usage did not document it. The script now defaults to dry
   run and accepts exactly one explicit `--apply` to permit changes. Invalid flags
   refuse before host checks. No bootstrap was run on the actual host in this round.
2. Stale operator statements: the [contract red run](logs/round-3/contract-red.txt)
   failed against the old VM README. Both VM guides, the ledger and release note now
   describe the completed one-person packaged PASS and its final peaks, remove
   concurrent three-person instructions and retain the unqualified-minimum limit.
3. Missing portable evidence: the same contract red run failed because the final
   PASS did not identify its collector or link final screenshots. Ten sanitised
   final screenshots are now published and linked beside that PASS. Each was
   visually inspected and matches its retained capture byte for byte. The retained
   collector is named with its checksum. Tests check all ten links, PNG signatures
   and widths.

An initial fixture snapshot included an unreadable apt-cache directory. It was
corrected to cover the directories the bootstrap can change, before the focused
failing-first run above. Two runs started before the output correction each passed 30/31: the unchanged
output assertion caught the missing lowercase `ready` marker. The completion text
now says that the dry-run plan is ready; the assertion was retained. The
[focused correction](logs/round-3/output-fix.txt) passed 3/3.

## Test scope and cleanup

The default invocation compares simulated host state before and after and requires
that no mutating stub ran. Explicit apply changes the fixture and permits an
identical owned rerun. Every guarded path, binary and unknown ownership marker
refuses before writes in default, dry-run and apply modes. Snapshots compare file
contents, permissions, ownership, directories and symlink targets. The existing
replaced-executable refusal also uses apply and requires no mutating step output.
The [snapshot cleanup check](logs/round-3/snapshot-cleanup.txt) passed 2/2.

Reuse the existing container fixture and Node test runner. Share the host snapshot
helper and usage output rather than copying their rules. Keep parsing before host
checks and all refusal checks before downloads, commands and writes. Production
functions stay below the existing size, complexity and parameter limits. Add no
dependency, retry, deadline or exception handler. Keep all access, money, memory,
image-approval and existing output assertions intact.

Fixtures have no network, capabilities or added privileges and mount source read
only. Apt, systemd, swap, archives and downloads are stubbed. No fixture starts
k3s, containerd or dockerd. This proves guarded script behaviour, not Ubuntu
kernel, boot or systemd correctness.

## Current gates

PASS: the final 31 tests passed twice without skips, in 247.07 and 255.61 seconds.
The command was `nice -n 10 node --test infra/vm/bootstrap.test.mjs`.

| Check | Result | Evidence |
| --- | --- | --- |
| Changed tests, twice | PASS | [First run](logs/round-3/pass1.txt), [second run](logs/round-3/pass2.txt) |
| Workspace, package and dev-stack typecheck | PASS | [Output](logs/round-3/typecheck.txt) |
| Event catalogue | PASS | [174 event types](logs/round-3/events.txt) |
| Knip | PASS | [Two existing configuration hints](logs/round-3/knip.txt) |
| Changelog lint | PASS | [Output](logs/round-3/changelog.txt) |
| Markdown lint | PASS | [569 files, no issues](logs/round-3/markdown.txt) |
| ShellCheck | PASS | [Bootstrap and both shared-runtime callers](logs/round-3/shellcheck.txt) |
| Repository scoped ESLint | NOT RUN for infrastructure | [Repository exclusion warnings](logs/round-3/eslint.txt) |
| Supplementary scoped ESLint | PASS | [Recommended rules and repository size/complexity limits](logs/round-3/eslint-extra.txt) |
| Process, ledger and README structure checks | PASS | [Output](logs/round-3/contracts.txt) |

Final-head CI is reported in the [PR checks](https://github.com/elewa-git/opencrane-new/pull/1171/checks).
This receipt records own local checks only.

All lint, typecheck and test commands use `nice -n 10`. No full root suite ran.
The bootstrap imports the operator-contract tests so its existing CI entry point
also checks the maintained statements and portable images.

## Journey and remaining work

PASS: retain the [23 November one-person packaged journey](journey.md#23-november-packaged-one-person-journey)
on approved source `abe90b2e9`. Runtime, product tests and build files remain
identical to that source. This round changes only `infra/vm`, documentation and
the release note. No journey was repeated and no dev-stack slot was claimed.
Host protection remains PARTIAL under the recorded accepted development-host switch. Real Ubuntu bootstrap and reboot
remain NOT RUN. Installation peaks and a minimum VM remain unqualified.

Fetched main at `5576ecd1d`, moved from `ed3662d85`. Rebase encountered a developer-stack
documentation conflict and was cleanly aborted. Main also introduces runtime,
test and build changes, so completing that rebase conflicts with retaining the
approved product source and reusing its journey. The owner decision is pending.
No rebase is in progress; rebase completion is NOT RUN.

## Short work log

1. Read the review, delivery rules and affected contracts; fetched main.
2. Committed failing contract and bootstrap regressions before their fixes.
3. Corrected the default, usage and current statements; published checked captures.
4. Kept approved product source, ran scoped gates and left the draft and worktree for review.
