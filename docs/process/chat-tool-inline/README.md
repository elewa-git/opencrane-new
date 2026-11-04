# Inline chat activity details

These Chromium captures show the saved command result under its activity line.
The page uses an intercepted chat API and live update socket. No development
stack is involved. The same fixture includes a governed tool line, whose Enter
and Space behaviour is checked after each capture.

| Width | Collapsed | Expanded |
| --- | --- | --- |
| 1280 px | [View](collapsed-1280.png) | [View](expanded-1280.png) |
| 390 px | [View](collapsed-390.png) | [View](expanded-390.png) |

Run `npm run visual:chat-tool-inline` to refresh the images.
The script checks that the details remain in the page, that the buttons report
their state to assistive technology, and that neither width scrolls sideways.
