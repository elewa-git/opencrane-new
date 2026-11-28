# Server style check

Journey on a fresh dev stack: NOT RUN

The source cleanup is ready for its checks. Fresh-stack CORE will run on secondary
slot 1 after the local gates, CI and both image approvals pass for the product commit.
The live pilot is excluded. No secondary slot has been claimed yet.

The change keeps product behaviour and public interfaces. It expands compact access
checks and response construction, names inputs and separates private approval and
key-error helpers. It shares the existing digest validator and the two identical
participation-reader identity checks. Two parameter-count exceptions are removed.
No dependency, event, access rule, size limit, timeout or test assertion changes.

Existing behaviour tests provide the regression checks. No new cosmetic test is
added. The initial test run had 117 passing checks and ten failures because its
pinned gateway binary link was missing. After linking and checking that binary,
all 19 affected gateway checks passed. Full final test results are pending.

The [scope list](scope.json) records the date window, changed files, files shared
with open pull requests, and files still needing the follow-up style check.
Package responsibilities and processes are unchanged. Its README files are shared
with open pull requests and are deferred with those files.

Independent review and a packaged browser installation are NOT RUN by this builder.
This slice requires fresh-stack CORE and package tests, plus image approvals.
Raw logs stay on the box only.
