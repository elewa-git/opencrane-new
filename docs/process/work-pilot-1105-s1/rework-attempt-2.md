# Second fresh rework attempt

Journey on a fresh dev stack: FAIL

Started from runtime changes `f82f1c672` on 15 November 2026. The later type-only
cleanup `7bb36d3c6` emitted identical JavaScript for all three affected modules.
Claimed secondary slot 1; fresh startup, status and browser installation passed.

The desktop journey passed. On the phone, saving and choosing the key, its initial
live call, consent off, the completed refusal and consent on passed. The final turn
completed in seven seconds with “The demo tool did not return a quote.” The collector
waited for the expected account text and eventually reported a timeout. That is a
failed restored-call assertion, not an unfinished turn.

All ten profile-list responses were HTTP 200; the previous reader defect did not
recur. The [failure record](rework-attempt-2-failure.json) and
[last browser state](rework-attempt-2-failure-390.png) retain the actual result.
Saved-event verification was NOT RUN because the collector stopped before it.
Host load measured 19.58 around failure, above the requested ceiling. The exact
reason for the missing quote remains unassigned; load alone does not establish it.

The cleanup trap ran `down.sh` successfully, status 0. The next collector fails
immediately on a completed wrong answer and saves whitelisted event diagnostics
and private process logs before teardown. The next orchestration also checks the
load ceiling before browser phases and actions. No product guard, assertion or
deadline was weakened. This attempt stays failed.
