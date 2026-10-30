# Memory contracts

The [server contract](../../README.robot.md) describes the existing memory commands.
The [initial personal load contract](../../../../docs/process/p4-15-pr5d/README.robot.md)
records the two evidence commands and their checks. The
[delivery contract](../../../../docs/process/p4-15-pr5f/README.robot.md) describes the
one-use internal consumer, current-reference checks and complete input limits.

Initial loading imports the deployment-owned collector reader. It accepts no caller evidence.
The collector contract defines the fixed files, current measurements and required complete
qualifications. Each command captures saved membership first and keeps one command-local
permission decision with its original access positions. MemberAccessRefused takes precedence
over dependency failures. The ten-second preparation and two-second append limits remain.
