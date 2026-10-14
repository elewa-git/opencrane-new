# Conversations screen capture

The capture script serves the built website with intercepted API replies. It does not
start a development stack. Browser motion is reduced.

| Screen | 1280 px | 390 px | Result |
| --- | --- | --- | --- |
| No search matches | [Capture](THR-01-1280.png) | [Capture](THR-01-390.png) | PASS |
| Loading more | [Capture](THR-02-1280.png) | [Capture](THR-02-390.png) | PASS |

The script checked each capture for horizontal overflow and visible controls smaller
than 44 px. Both checks passed at both widths. The loading capture keeps its first
page visible while the second request waits. These captures do not exercise a live
server or a fresh installation.
