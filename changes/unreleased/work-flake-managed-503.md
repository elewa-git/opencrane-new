Managed-mode switch-on tests now wait for the replacement models process to become ready
before checking that a legacy call is refused with 403. The old gateway can return 503
while it drains during shutdown; the test still checks that the legacy process exits.
