"""Record process memory and descriptors for one claimed secondary stack."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from datetime import datetime, timezone


def command_output(arguments):
    result = subprocess.run(arguments, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def container_process(project, service, expected_command):
    container = command_output([
        "docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
        "--filter", f"label=com.docker.compose.service={service}",
    ])
    if not container:
        raise RuntimeError(f"No running {service} container")
    processes = command_output(["docker", "top", container, "-eo", "pid,args"])
    for line in processes.splitlines()[1:]:
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and fields[1].startswith("/sbin/docker-init "):
            continue
        if len(fields) == 2 and expected_command in fields[1]:
            return int(fields[0])
    raise RuntimeError(f"No {service} process matching {expected_command}")


def process_reading(pid):
    status = Path(f"/proc/{pid}/status").read_text()
    rss_kib = None
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            rss_kib = int(line.split()[1])
    # Container processes can use a different uid. Count names without reading descriptors.
    descriptors = command_output(["sudo", "-n", "ls", f"/proc/{pid}/fd"])
    return {"pid": pid, "rssKiB": rss_kib, "fds": len(descriptors.splitlines())}


def sample(stack_id, directory):
    project = f"opencrane-dev-{stack_id}"
    readings = {}
    for name in ["server", "dispatcher", "models", "openfga"]:
        try:
            if name in ["server", "dispatcher"]:
                pid = int((directory / f"{name}.pid").read_text().split()[0])
            elif name == "models":
                pid = container_process(project, name, "infra/dev-stack/secondary-models.ts")
            else:
                pid = container_process(project, name, "openfga run")
            readings[name] = process_reading(pid)
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
            readings[name] = {"error": str(error)}
    return {
        "date": datetime.now(timezone.utc).isoformat(),
        "stackId": stack_id,
        "processes": readings,
        "serverHeapUsedBytes": None,
        "heapNote": "The server does not expose V8 heap used; RSS is recorded instead.",
        "cpuPressure": Path("/proc/pressure/cpu").read_text().strip(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    arguments = parser.parse_args()
    stack_id = os.environ.get("DEV_STACK_ID")
    if stack_id not in ["1", "2"]:
        parser.error("DEV_STACK_ID must name a claimed secondary stack")
    directory = Path.home() / ".config" / "opencrane" / f"dev-stack-{stack_id}"
    owner = (directory / "stack-owner").read_text().splitlines()[0]
    root = Path(__file__).resolve().parents[2]
    if owner != f"worktree={root}":
        parser.error("This worktree does not own the selected stack")
    stopped = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    with arguments.output.open("a") as output:
        while not stopped:
            started = time.monotonic()
            output.write(json.dumps(sample(stack_id, directory)) + "\n")
            output.flush()
            remaining = max(0, 5 - (time.monotonic() - started))
            time.sleep(remaining)


if __name__ == "__main__":
    main()
