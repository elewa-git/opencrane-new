# Opening People after accepting an invitation

**Fresh-stack journey — PASS.** Run on 26 November 2026 in slot 1 from source
commit `1f41c5f2204e8d53f6c13dae017fd867a4bbbaea`.

1. Started a fresh secondary stack with the stand-in model and checked that its
   services were healthy. The invitations were prepared for test accounts.
2. At each width, a different person signed in, accepted an admin invitation and
   opened People straight away. Acceptance and the first directory read both
   returned HTTP 200. Their own member row and an enabled **Invite people** button
   were visible without refreshing.
3. A third person accepted an ordinary Member invitation. Their own member header
   returned HTTP 200. When they opened People at each width, the directory returned
   HTTP 403. The page showed **Your access changed** and hid member rows and the
   invite button.
4. Saved the screenshots, stopped the stack and checked that slot 1 was free.

| Check | 1280 px | 390 px |
| --- | --- | --- |
| New admin opens People with **Invite people** | [PASS, 1.37 s](admin-people-1280.png) | [PASS, 2.14 s](admin-people-390.png) |
| Ordinary member is refused | [PASS](member-refused-1280.png) | [PASS](member-refused-390.png) |

Times run from the join reply to the visible invite button. Screenshots hide
contact details. The live runs applied both joins by the first directory read.
The server tests hold back the member table or the permissions service to check the HTTP 425
reply. The web test checks that the page then reads again.
