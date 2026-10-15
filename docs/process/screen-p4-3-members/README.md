# Members screen receipt

The capture command opens built pages with intercepted reads. It starts no dev stack.
Each state has a 1280px and 390px image: loading, current, Load more, no matches,
stale rows, first failure and access loss. The browser check found no overflow or
control smaller than 44px. It also checked that names and emails disappear after 403.

The list frames were adapted to current data: Last active says “Not available yet”.
Invite and member actions are absent. Member rows stay unlinked until the detail
screen is built. Only a current server count is shown. Groups still open through
`?tab=groups`; the group count is hidden because that read supplies no current total.

Visual capture: PASS. Member detail and its access states: NOT RUN in this part.
