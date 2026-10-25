# Private details in public files

`npm run lint:docs` runs `scripts/check-public-privacy.mjs` over every tracked text
file, including logs, HTML, JSON, code and test fixtures. It rejects email addresses
at the owner's domain, including subdomains and mixed case, and absolute host home
directories. Errors show file names and line numbers without repeating private values.
Binary files are outside this check.

Public records use these placeholders:

- `<owner-email>` means the owner email supplied privately.
- `<home>` means the operator's home directory.
- `<stack-dir>` means a private development stack directory.
- `<worktree>` means the checkout used for a command or run.

Specs and guides can say “the owner test user, configured privately” instead of
showing an address. Executable fixtures use reserved example addresses.
Relative paths such as `.tools/home/<id>` are tool directories within the checkout.
They do not name an absolute host home directory.

The computer image and its isolation tests use five fixed container accounts:
`<home>/agent`, `<home>/codex`, `<home>/desktop`, `<home>/private` and
`<home>/tool`, with paths beneath them. The `<home>` placeholder stands for the
container's home directory. These paths name container users and private turn
directories, not people or host installations.

The real development owner email belongs in a private file outside the checkout
and disposable stack directories. The [stack operator notes](../../infra/dev-stack/README.robot.md#private-owner-email)
and [package operator notes](../../infra/package/README.robot.md#private-owner-email)
describe how bootstrap and package checks read it.

Historical logs retain their original lines, with private strings replaced.
File hashes that identify changed text are refreshed to describe the public copy.
Source commit ids and container image digests still identify the original run.
Git history is unchanged. Screenshot emails were masked in a separate follow-up.

[The screenshot list](public-privacy-screenshots.md) names the masked files and
records the visual checks and text-recognition coverage.
