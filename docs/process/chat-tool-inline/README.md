# Inline chat activity details

These Chromium captures show plain command labels and the saved result under an
activity line. The Activity panel lists the newest action first.
The page uses an intercepted chat API and live update socket. No development
stack is involved. The same fixture includes a governed tool line, whose Enter
and Space behaviour is checked after each capture.

| Width | Collapsed | Expanded | Activity |
| --- | --- | --- | --- |
| 1280 px | [View](collapsed-1280.png) | [View](expanded-1280.png) | [View](activity-1280.png) |
| 390 px | [View](collapsed-390.png) | [View](expanded-390.png) | [View](activity-390.png) |

Run `npm run visual:chat-tool-inline` to refresh the images.
The script checks that the details remain in the page, that the buttons report
their state to assistive technology, and that neither width scrolls sideways.
