# Approval details for every participant

People in a conversation can read the approval's reviewed fields and consequence.
Only its requester can approve or deny it. The card uses the approval read and
does not guess the requester's name.

The remaining designed states need facts the browser cannot currently read:

- WRK-05 needs recorded attempt history and times.
- WRK-06 needs a native consent event and a reported refusal.
- WRK-13 needs an approval with a missing required review field. The current
  approval contract rejects that review instead of returning a card.
- WRK-30 needs proof that a failed call was stopped before dispatch and is safe
  to repeat.

These states remain blocked until the server exposes those facts.
