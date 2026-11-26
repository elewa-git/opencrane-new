# Packaged onboarding and Memory

Journey on a fresh dev stack: PASS

A fresh Helm install on slot 1 used source commit
`9f31b2a9414e0bcb885a68d93f9f1d3a3ef00fe7` after hosted CI and both image
approvals passed. The package started and passed its ownership check. It used
qualification mode with the free stand-in. The welcome used its saved script
and made no model call. The installer logged the documented
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` exception for swap and
crash dumps.

| Step | Result | Screenshots |
| --- | --- | --- |
| Each invited member signed in, accepted the invitation and opened the survey | PASS | [1280 px](survey-1280.png), [390 px](survey-390.png) |
| The member on a phone signed in again and resumed at the second survey step | PASS | [390 px](survey-resumed-390.png) |
| Both members saved the survey and approved the persona | PASS | [1280 px](persona-1280.png), [390 px](persona-390.png) |
| Both members opened the welcome chat, sent an answer and saw completion | PASS | [1280 px](welcome-1280.png), [390 px](welcome-390.png) |
| Both finished members signed in again and went straight to the workspace | PASS | [1280 px](return-1280.png), [390 px](return-390.png) |
| Both members saved a fact in Memory and saw it listed after reloading | PASS | [1280 px](memory-1280.png), [390 px](memory-390.png) |
| The owner skipped setup and signed in again to the workspace | PASS | |
| A signed-out visitor saw a sign-in prompt and no survey answers. The request returned 401. | PASS | [390 px](signed-out-390.png) |

The screenshots were saved before teardown. Both cleanup commands passed and
slot 1 reported free.

The packaged backup does not yet include the survey, persona or Memory keys.
