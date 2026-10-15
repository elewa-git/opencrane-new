# Welcome survey screen receipt

These captures use intercepted API replies and reduced motion. They show the page
at 1280px and 390px, without a development stack. The capture checked that
visible controls are at least 44px, the Back link stays within the viewport,
and the page has no horizontal overflow.

| State | Result | What the capture shows |
| --- | --- | --- |
| ONB-10 | PASS | A new person's name and optional pronouns form. |
| ONB-11 | PASS | A linked name error with no save. |
| ONB-12 | PARTIAL | The saved first step leads to the work step, which is unavailable in this part. |
| ONB-15 | PASS | Saving, known failure and unknown save outcome. |
| ONB-16 | PARTIAL | The real saved time appears; the work step is unavailable. |
| ONB-17 | PASS | Loading, failed read with retry, and a choice when saved steps return. |

The captures check layout and displayed states. Live API access and a fresh-install
journey are NOT RUN. The work step, style and tasks are for a later part.
