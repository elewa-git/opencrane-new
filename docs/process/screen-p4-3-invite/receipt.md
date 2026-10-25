# Invitation panel screen check

The browser captures use intercepted API replies with an Owner signed in as
`<email>`. They cover the form, invalid address, created link, copied link
and uncertain create reply at desktop and phone widths. Motion is reduced. The
script checks for horizontal overflow and controls smaller than 44 pixels.
It also checks that Done returns focus to Invite people and that an invalid
email field uses the same red as its error message. Before the fix, that
border check failed at 1280 pixels. After the fix, the browser checks PASS
for the ten captures, including the refreshed invalid-field images at 1280
and 390 pixels. A live invitation journey is NOT RUN.

After the member detail page was added, this browser check also found that a
short member name made its link narrower than 44 pixels. The link now has a
minimum width of 44 pixels, and the same target check passes at both widths.

The invitation panel test held 401 and 403 response bodies open after their
statuses arrived. Before the fix, both cases failed because the address stayed
in the open form. After the fix, both cases PASS: the form closes and clears
the address without waiting for either body.

The accepted frames show a directory match. This build uses email input because
the server confirms the person's identity when they accept. The form does not say
whether an account exists. The invitation list and join page are not available yet.
These captures check the screen only; they do not prove a live invitation journey.
