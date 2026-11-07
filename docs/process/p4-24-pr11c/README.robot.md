# Company routine call contract

Part of #106. The private broker reads the saved allowed decision, frozen routine
run, explicit owner choice, company profile, opt-in, configuration and published tool
before the short access check. A trusted caller must check current owner, assistant,
group, grants, payer, computer and root. The audit command checks its saved positions
and current routine control again. It claims one release record without reading
private material. A later broker part must recheck before the hand-off.

The company verification reader is injected only in tests. No production caller,
company activation, routine sender switch, model call or owner stack is used. The
fixture has disposable NATS, PostgreSQL and OpenFGA and a synthetic company account.
The recording upstream part and fresh-install qualification are NOT RUN.

## Own checks

The failing-first test commit is `fa8db6ef8`. Final check results are in
[receipt.md](receipt.md).
