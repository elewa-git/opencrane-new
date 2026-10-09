Model calls keep grant history in memory and read only new grant events during
their short access check. Revoked access still refuses calls before they are sent,
while unrelated activity keeps working under the same spending rules.
