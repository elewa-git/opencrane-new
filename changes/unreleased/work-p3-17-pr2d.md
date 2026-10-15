Saved control intent now sends a signed work-stop gate to a ready computer, including
idle computers and the first frame after reconnecting. The server checks the reply
and keeps it only for that connection. This does not grant desktop control or save
proof that the computer is paused.

Slow chat reads, uploads and saved-report reads no longer hold up the work-stop gate.
A turn finishing during signing triggers fresh checks before reports can resume.
