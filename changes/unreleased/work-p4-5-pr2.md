Conversation access now reads saved participant changes from the small participation
stream. Removal cuts off chat, approval, file and desktop access before permissions
finish applying. Late joins see only their latest interval, including transcript rows
and titles. Busy conversations keep their readers, and sockets check removals while
content is waiting. Participant changes cannot be requested through an endpoint yet.

Closed sessions refuse files and desktop access even when a later report arrives before
read tables catch up. Approval decisions reuse checked history, and repeated access
reads check each old participation record once. Late participants can download only
screenshots saved since their latest join.

Memory source links also hide messages saved before the caller's latest join.

Desktop and file checks reuse records already checked for a close while background work
is behind. They still check every newer record and refuse access after a saved close.
Conversation lists reuse unchanged member and creation facts within each request.
They check saved changes again after the permissions service answers.
