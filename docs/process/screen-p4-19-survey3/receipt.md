# Welcome survey screen check

The intercepted browser captures cover style, tasks, long task text, saving,
safe failure, stale progress, unknown status, resuming, the completed survey
and the Assistant page. The last two captures were refreshed after the wording
change. Captures use 1280 and 390 pixels with reduced motion. Both widths
passed the horizontal overflow check. Survey controls passed the 44 pixel size
check. The Assistant page uses the existing settings navigation, whose links
are smaller; that page was not part of the survey control size check.

The recovery test starts after a failed progress read, finds four saved steps,
and keeps them. It checks the saved work, style, task choices and own task.
Moving through those answers sends no POST. A separate page test checks that
the Assistant page says persona review is unavailable without claiming an
assignment or reading assignment status. Both tests failed before the fixes
and passed afterwards.

The focused browser tests passed twice: 67 tests across the survey and app
files. The web build passed. These checks use intercepted replies; a
fresh-install journey is NOT RUN. Persona review remains unavailable.
