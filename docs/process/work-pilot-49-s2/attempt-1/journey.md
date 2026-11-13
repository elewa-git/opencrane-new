# First fresh-stack attempt

Date: 13 November 2026. Application source: `f133cc98020a5dcfbbce01d02172923beffe4d4b`.
Journey on a fresh dev stack: FAIL.

Claimed secondary slot 1 through the normal guard and started it with `--fresh`.
Startup qualification and health checks passed. The bundled approval journey was
skipped by its existing runner; it was NOT RUN and is outside this slice.

Used separate real sign-ins, personal assistants and keys against the actual demo
server in credential-checked mode. Both accounts had permission. Installed,
reviewed and published through the browser. Two initial evidence-collector waits
assumed that status refreshed automatically. Used the existing Check status controls
to read the original discovery and publication outcomes; did not repeat either write.

At 1280 px, both simultaneous turns returned their own accounts. B revoked their
key, B's next call was refused in 8,328 ms, and A's next call still returned account A.
See the [observations](observations.json), [A result](a-concurrent-1280.png),
[B result](b-concurrent-1280.png), [refusal](b-next-call-refused-1280.png) and
[A after revocation](a-after-revoke-1280.png).

At 390 px, each member explicitly connected, verified and selected a new own key.
A's concurrent call returned account A. B's tool call was refused before credential
release. The reply said the tool did not return a quote. The overall journey failed.
See [B's failed call](failure-1-390.png), [failure metadata](failure.json) and
[sanitised release events](release-diagnosis.jsonl).

The dispatch log identified `credential_release`, `decision_unavailable`, elapsed
2,321 ms and 27,677 ms remaining on the lease. B had a current own selection and
admission, but no credential release. The two-second access work expired; the
30-second lease had not expired. No other member's credential was used.

Stopped the guarded demo launcher, closed browser contexts and ran
`infra/dev-stack/down.sh` for the claimed slot. The slot was released. Kept this
worktree and the failed evidence for review.
