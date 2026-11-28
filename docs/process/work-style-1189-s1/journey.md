# Package style cleanup

Journey on a fresh dev stack: NOT RUN

The required journey is CORE on a fresh secondary stack in slot 1. The live pilot
uses slot 2 and is excluded from the availability check. No slot has been claimed.

## Behaviour checks

The original provider tests passed before the cleanup. The added model-secret tests
cover an embedded stand-in key in provider mode and missing settings in stand-in
mode. Removing the embedded-key refusal made the new test fail with a missing
expected exception. Restoring the original check made all three tests pass.

The cleanup keeps provider setup order, browser selectors, time limits, refusals
and error handling. It moves the key-mode probe beside the other provider probes.
It adds no dependencies and changes no event or public API.

The date window ends at `2e24538b0e944935f9a3a613693b1b14bc41eec1`.
The navigation collector was replaced after that date and remains unchanged.
The later shutdown logger and automatic chat-default helper remain unchanged too.

## Scope left for the next part

The remaining long sign-in flows in `qualification-signin.mjs`, and the other
package files changed in the ticket's date window, still need the same check.
Package READMEs, image tooling, scanner settings and install preparation are left
untouched where the two open pull requests also change them. The [scope list](scope.json)
names each remaining source file and each skipped file in the date window.
