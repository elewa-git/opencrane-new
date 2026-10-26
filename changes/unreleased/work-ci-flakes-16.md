Personal account saves and cleanup allow brief database delays while still refusing work when their shared lock cannot be acquired within one second.
Personal account saves preserve an access refusal if releasing their database lock fails or its connection is lost. Successful work still reports a coordination failure in those cases.
