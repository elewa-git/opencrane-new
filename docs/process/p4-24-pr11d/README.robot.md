# Company routine Ask release contract

Part of #107. This is the first bounded part of the routine Ask binding.

`companyCredentialReleaseSchema` requires an Ask id, root id, destination digest
and tool revision in addition to its existing company identity. The saved Ask
may carry one strict `routine` binding. It holds only identifiers, revisions
and digests; the private review remains encrypted. The generic approval route
still checks the requester and step-up before saving a decision.

Before the company release audit, `routineCompanyAskFacts` reads the exact Ask
stream. It requires a models request, an approval by the original human owner,
and one models use for the same permit. Other states, an extra use, missing
consequence fields and a hold longer than 15 minutes refuse. It compares the
owner, occurrence, root, turn, thread, payer, company profile and verified
account, tool and schema revisions, argument and destination digests. The audit
then checks the Ask stream position again with current owner and tool access.
The company profile and published tool checks still run separately before that
short access check. They now check the registered destination and distinct tool
and catalogue revisions. Reading the Ask never saves an event.

The company verification reader is injected only by tests. Production still
has no caller for company release or routine execution. This part records no
company credential hand-off and does not qualify a live upstream effect.

## Own checks

See [receipt.md](receipt.md).
