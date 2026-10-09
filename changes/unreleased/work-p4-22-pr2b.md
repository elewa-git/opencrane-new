Model calls keep grant history in memory and read only new grant events during
their short access check. Revoked access still refuses calls before they are sent,
while unrelated activity keeps working under the same spending rules.

Compact grant summaries keep 100,000 UUID grantees within their estimated memory
budget. Warm calls stay cached across a model with 10,000 members and eight more
models with 1,000 members each. Grant revocations before and after catch-up still
refuse calls while permission updates are delayed.
