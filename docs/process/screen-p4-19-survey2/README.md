# Welcome survey work step screen receipt

These screens use intercepted replies and reduced motion. They do not use a
development stack. The capture checked both 1280px and 390px widths for horizontal
overflow, visible 44px controls and a Back link that stays in the viewport.

| State | Result | What it shows |
| --- | --- | --- |
| ONB-12 | PASS | Work text and one current group, read only. |
| ONB-12 byte error | PASS | A linked UTF-8 byte error. |
| ONB-12 groups failed | PASS | Continue is blocked until Try again reads groups. |
| ONB-15 on step 2 | PASS | Saving, known failure and unknown outcome. |
| ONB-16 | PASS | Resume at step 3 with two saved steps and the real saved time. |

The screenshots show layout and intercepted browser states. A fresh-install
journey is NOT RUN. Style and task steps remain unavailable.
