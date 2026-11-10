# Typanion source and retained Corepack bytes

Date: 10 November 2026. Part of #15. Overall: PARTIAL. Live: NOT RUN.

The [record](grant.json) names one typanion 3.14.0 module and its complete
38,565-byte range in Corepack 0.34.6. The exact upstream Git revision is
`ab9f045afc697c998aff66992ad48cb8ba3478a4`. The saved source archive
contains its README, package and source files. The README has Maël Nison's
2020 copyright, the MIT permission, the condition to keep the notice and the
full disclaimer. The package declares MIT. The npm release metadata names
that Git revision. Its published tarball has a built `lib/index.mjs`, but no
separate licence file.

The built module differs from the retained Corepack range. The Git tree has
TypeScript source and no built `lib/index.mjs`. This check does not prove every
change made by the build and bundler. The typanion grant is therefore BLOCKED.
The README's complete terms would need to accompany any permitted image
distribution. A package label alone does not approve the code.

The [checker](check-typanion.py) repeats the signed Node and Corepack inventory
checks. Those checks read the archived Dockerfile and both candidate layers.
It binds the original Corepack archive and range list, the upstream Git files,
the saved source archive and the candidate record. It hashes the original
candidate and source archives again after inspection. A changed or missing
input returns one fixed error without a local path.

Other unknown modules, the missing npm tree, Go, kubectl and agentgateway
terms, vulnerabilities, exact-source R3 and image promotion remain BLOCKED.
No runtime pin, approved inventory or promotion gate changes here.

## Own checks

- PASS — The saved signed Node, Corepack and candidate archive evidence reached
  the bounded BLOCKED result.
- PASS — Seven Python fixtures through Vitest, twice. Removing four direct guards
  made their matching refusal assertions fail. Each archive recheck was reached
  after a successful mocked run and then refused altered bytes.
- PASS — Scoped ESLint, typecheck, event catalogue, Knip, changelog and Markdown lint.
- PASS — 482 security rules with a disposable PostgreSQL URL.
- PASS — Public privacy check and JSON field-name check.
- NOT RUN — Full root suite, rebuild, publication, dev stack and live journey.
