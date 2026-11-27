# Opening People after claiming or joining

**Fresh-stack journey — PASS.** Run on 27 November 2026 on secondary slot 1
from source revision `d21eb541e59f43f118a632e7860d2c3e8e48a355`.
The stack used the stand-in model and the first-owner claim flow.

1. Claimed slot 1 after five minutes with the host load below 6. Started it
   with `up.sh --fresh --id 1` and confirmed it was healthy with `status.sh --id 1`.
2. Signed in as the first owner, submitted the installation claim and received
   HTTP 201. Opened People in two browser tabs as soon as the claim was confirmed.
   Both showed the owner row and an enabled **Invite people** button. Neither
   received HTTP 503.
3. Used the owner's invitation API to prepare two admin invitations. A different
   person accepted one at each width and opened People straight away. Each saw
   their member row and an enabled **Invite people** button without refreshing.
   The desktop read returned HTTP 425 once before the automatic retry succeeded.
4. A third person accepted an ordinary Member invitation. Their own member header
   returned HTTP 200. At both widths, People returned HTTP 403 and showed
   **Your access changed**. The page contained no member rows or invite button.
5. Saved six screenshots with contact details hidden. Ran `down.sh --id 1`
   and confirmed slot 1 was free.

| Check | 1280 px | 390 px |
| --- | --- | --- |
| First owner sees **Invite people** | [PASS, HTTP 200 in 1.90 s](owner-people-1280.png) | [PASS, HTTP 200 in 2.99 s](owner-people-390.png) |
| Invited admin sees **Invite people** | [PASS, HTTP 425 then 200 in 4.61 s](admin-people-1280.png) | [PASS, HTTP 200 in 1.92 s](admin-people-390.png) |
| Ordinary member is refused | [PASS, HTTP 403](member-refused-1280.png) | [PASS, HTTP 403](member-refused-390.png) |

Times run from the claim or join reply to the visible invite button. The server
tests also hold back the member table and OpenFGA separately. The website tests
check that earlier rows clear on the first applying reply and stay hidden if
the retries run out.
