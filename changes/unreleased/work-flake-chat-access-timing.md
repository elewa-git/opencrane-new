## Chat access timing checks

The child chat reader check now allows up to two seconds for its HTTP reply. A
loaded run returned the expected content in 1,744 ms, which met the two-second
access bound but exceeded the test's former 1.5-second limit.

The removal-after-IAM check keeps its two-second access assertion. Its test now
allows two minutes for the surrounding NATS, PostgreSQL and OpenFGA fixtures to
start and stop, after a CI run timed out at the old 30-second test limit.
