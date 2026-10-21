# Initial tool publication screens

Date: 2026-10-21T10:22:38.666Z. Source base: 4196f3a6f6baa5eb6136216f12865400ca429dc6, plus working-tree changes.

PASS: all 30 intercepted browser captures at 1280 and 390 px, with reduced motion,
modal focus, controls at least 44 px high and no horizontal overflow.
The phone review action fills the panel. Phone confirmation actions sit at the bottom.
Applying and Ready hide the review form. Ready uses a check and has no paused-call paragraph.
Lost, malformed, stale, wrong-reference and wrong-configuration results use a neutral
unknown card with Check status near the top. Conflict uses an orange warning and offers
Discard my edits. Refusal clears protected details and links to Overview.
Applying and lost replies survive reload. Only the original change is checked.
A lost initial review stays unknown and keeps its original reference.

PASS: the three-check regression first failed by showing confirmed after sequence 7
and Unknown. It now keeps sequence 7, Unknown and the recovery reference after releasing
an older policy reply and an older Ready reply. A later read of a lower policy sequence
also leaves the newer policy in place.

PASS: removing each of 13 guards separately made its matching test fail. These cover
the receipt server, change, review and generation, both source sequence bounds,
expired and out-of-order Ready, and the five staged review bindings. All guards were restored.
Other listed coverage gaps are unchanged.

| Guard removed | Deliberately wrong value | Result with guard removed |
| --- | --- | --- |
| Receipt server | `another-server` | FAIL as expected |
| Receipt change | `another-change` | FAIL as expected |
| Receipt review | `3` instead of `4` | FAIL as expected |
| Receipt generation | `2` instead of `1` | FAIL as expected |
| Source sequence lower bound | `4`, equal to the expected sequence | FAIL as expected |
| Source sequence upper bound | `7`, above policy sequence `6` | FAIL as expected |
| Policy expiry | Expired by one millisecond | FAIL as expected |
| Ready date order | Requested after observed | FAIL as expected |
| Staged sequence | `7` instead of `6` | FAIL as expected |
| Staged policy revision | `3` instead of `2` | FAIL as expected |
| Staged connection | `another-connection` | FAIL as expected |
| Staged account mode | `company` instead of `none` | FAIL as expected |
| Staged catalogue digest | Missing instead of the staged digest | FAIL as expected |

PASS: 144 selected web tests twice on the final source, with one worker, the requested
PG_TEST_URL and nice -n 10. The web build, typecheck, event catalogue, Knip,
changelog check and documentation lint also passed.

Frames used: INT-30 tools, INT-34 review, INT-35 confirmation, INT-36 publishing,
INT-93 conflict, INT-94 refusal and INT-95/96 unknown and confirmed results.

PARTIAL: these remaining frame differences are deferred to the expanded-frame part:

- Tools, empty and loading: breadcrumbs and completed-step marks differ. Desktop
  Connection says unavailable. Tools use a fieldset rather than compact description
  rows and omit the audience and Back action.
- Review: the Before/After table and approval JSON replace the compact consequence
  summary. Audience is separate. Back and Refresh remain extra controls.
- Confirmation: the audience and actual mode summary, top Cancel, divided header and
  footer and rule callout remain absent. A digest replaces the catalogue summary.
- Applying and Ready: headings and step bars retain the existing layout. Expanded
  publication and apply details remain deferred.
- Unknown: no outcome timestamp is shown because the uncertain reply supplies none.
  The copy does not claim that a malformed or mismatched reply was lost.
- Conflict: the reply supplies no person or time. Review again replaces Review their
  change. Discard opens the tools page for a fresh read.
- Refusal: the copy says access changed without inventing a role-change time.
  The existing Owner or Admin guidance remains below the cleared-details message.
- Desktop pages omit the frame's signed-in-user footer. Shared step marks and
  breadcrumbs still differ from the frames.

PARTIAL: the integration facts route is absent on this base. The page shows the saved
policy's connection and account mode and says additional facts are unavailable.

NOT RUN: full root suite, fresh-install journey, real gateway acknowledgement or paid calls.
