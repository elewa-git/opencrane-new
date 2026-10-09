Owners and admins can change an active non-owner between Member and Admin through
the API and check the original result after a lost reply. An admin who steps down
to Member can still read their own minimal receipt.

A role change that reaches an Owner keeps the owner role without stopping the
member or permissions worker. Ownership step-down now requires another active owner.
Role and appointment jobs follow saved order even when delivered in a different order.
Status waits for the appointment's permissions in either saved order.
