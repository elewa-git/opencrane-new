import datetime
import json
import pathlib
import subprocess
import time

root = pathlib.Path('/home/jente/.config/opencrane/dev-stack-2')
server_pid = (root / 'server.pid').read_text().split()[0]
nats_pid = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Pid}}',
                                    'opencrane-dev-2-nats-1'], text=True).strip()
output = pathlib.Path('docs/process/i77-live-view/diag/scheduler.jsonl')
while pathlib.Path('/proc/' + server_pid + '/schedstat').exists():
    record = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    record['load'] = pathlib.Path('/proc/loadavg').read_text().split()[:3]
    record['cpuPressure'] = pathlib.Path('/proc/pressure/cpu').read_text().strip()
    for name, pid in [('server', server_pid), ('nats', nats_pid)]:
        try:
            parts = pathlib.Path('/proc/' + pid + '/schedstat').read_text().split()
            record[name] = {'cpuNs': int(parts[0]), 'runQueueNs': int(parts[1]),
                            'timeslices': int(parts[2])}
        except FileNotFoundError:
            pass
    with output.open('a') as destination:
        destination.write(json.dumps(record) + '\n')
    time.sleep(2)
