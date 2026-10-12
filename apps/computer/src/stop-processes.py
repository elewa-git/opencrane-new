"""Stop this user's processes inside the computer, without CAP_KILL."""
import os
import signal

# Refuse to broadcast as root if the supervisor ever fails to drop the user ID.
if os.getuid() not in (1001, 1003) or os.geteuid() != os.getuid():
    raise RuntimeError('Executor user required')

try:
    # Let the kernel lock the process list while signalling this user's processes.
    # Exclude this helper automatically; it exits before the supervisor scans threads.
    os.kill(-1, signal.SIGKILL)
except ProcessLookupError:
    # Allow an already empty user, then let the supervisor check every thread.
    pass
