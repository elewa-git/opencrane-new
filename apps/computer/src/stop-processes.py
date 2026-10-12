"""Stop checked processes as their own user, without CAP_KILL."""
import json
import os
import pathlib
import signal
import sys

for identity in json.loads(sys.argv[1]):
    pid = identity['pid']
    descriptor = None
    try:
        # Bind the signal to this process, even if its PID is reused later.
        descriptor = os.pidfd_open(pid)
        stat = pathlib.Path(f'/proc/{pid}/stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        if fields[19] != identity['startTime']:
            continue
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except FileNotFoundError:
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)
