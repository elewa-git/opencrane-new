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

The only allowed absolute home names are the five fixed container accounts
`/home/agent`, `/home/codex`, `/home/desktop`, `/home/private` and `/home/tool`,
and paths beneath them. These names are runtime paths in the computer image and
its isolation tests. They stand for container users and private turn directories,
not people or host installations. Other user names fail the check.

The real development owner email belongs in a private file outside the checkout
and disposable stack directories. The [stack operator notes](../../infra/dev-stack/README.robot.md#private-owner-email)
and [package operator notes](../../infra/package/README.robot.md#private-owner-email)
describe how bootstrap and package checks read it.

Historical logs retain their original lines, with private strings replaced.
File hashes that identify changed text are refreshed to describe the public copy.
Source commit ids and container image digests still identify the original run.
Screenshots and Git history are unchanged by the text sweep.

[The screenshot list](public-privacy-screenshots.md) records visible email text
that remains in the unchanged images for a separate decision.
