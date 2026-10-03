"""Isolated fixture lifecycle; never touches opencrane-dev or its volumes."""
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

from checks import read_private

ROOT = Path(__file__).resolve().parent
PRIVATE = Path.home() / '.config/opencrane/odoo'
STATE = ROOT / '.state'
ENV = dict(os.environ, ODOO_PRIVATE_DIR=str(PRIVATE),
           ODOO_OPERATOR_UID=str(os.getuid()), ODOO_OPERATOR_GID=str(os.getgid()))
COMPOSE = ['docker', 'compose', '--project-name', 'opencrane-odoo-fixture', '-f', str(ROOT / 'compose.yaml')]


def compose(*args, **kwargs):
    return subprocess.run([*COMPOSE, *args], env=ENV, check=True, **kwargs)


def write_private(name, value):
    path = PRIVATE / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(value)


def setup():
    if os.getuid() != 1000:
        raise SystemExit('This dev-box fixture requires operator UID 1000')
    PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if PRIVATE.is_symlink():
        raise SystemExit('Private directory must not be a symlink')
    info = PRIVATE.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit('FAIL unsafe private directory permissions')
    if not (PRIVATE / 'database.password').exists():
        write_private('database.password', secrets.token_hex(32) + '\n')
    password = read_private('database.password')
    for path in PRIVATE.iterdir():
        read_private(path.name)
    if not (PRIVATE / 'odoo.conf').exists():
        write_private('odoo.conf', f'''[options]
admin_passwd = {secrets.token_hex(32)}
db_host = database
db_port = 5432
db_user = odoo
db_password = {password}
db_name = opencrane_fixture
dbfilter = ^opencrane_fixture$
list_db = False
addons_path = /opt/odoo/odoo/addons,/opt/odoo/addons
data_dir = /var/lib/odoo
http_interface = 0.0.0.0
http_port = 8069
workers = 0
max_cron_threads = 0
proxy_mode = False
log_level = warn
''')
    STATE.mkdir(exist_ok=True)


def ready():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        try:
            with opener.open('http://127.0.0.1:18069/web/health', timeout=2) as response:
                if response.status == 200:
                    print('PASS Odoo HTTP readiness at 127.0.0.1:18069')
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(1)
    raise SystemExit('FAIL Odoo readiness deadline; inspect this fixture only')


def start():
    setup()
    compose('build', stdout=(STATE / 'build.log').open('w'), stderr=subprocess.STDOUT)
    for name, image in [('odoo', 'community'), ('database', 'database'), ('operator', 'operator')]:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'python3',
                        '-v', f'{ROOT}:/fixture:ro', f'opencrane-odoo-{image}:p3-11',
                        '/fixture/licences.py', 'check', name], check=True)
    compose('up', '-d', '--wait', 'database')
    if not (PRIVATE / 'fixtures.json').exists():
        with (STATE / 'setup.log').open('w') as log:
            compose('run', '--rm', '--no-deps', 'odoo', '-c', '/run/fixture/odoo.conf', '-i', 'sale', '--without-demo=True',
                    '--stop-after-init', '--no-http', stdout=log, stderr=subprocess.STDOUT)
            compose('run', '--rm', '--no-deps', '-T', '-v', f'{PRIVATE}:/run/setup:rw',
                    'odoo', 'shell', '-c', '/run/fixture/odoo.conf', '--no-http',
                    input="exec(open('/fixture/seed.py').read())\n", text=True,
                    stdout=log, stderr=subprocess.STDOUT)
    compose('up', '-d', '--wait', 'odoo', 'operator')
    ready()


def reset():
    setup()
    compose('down', '--volumes', '--remove-orphans')
    for name in ['writer.key', 'reader.key', 'writer.key.new', 'reader.key.new', 'fixtures.json']:
        (PRIVATE / name).unlink(missing_ok=True)
    start()


if __name__ == '__main__':
    os.umask(0o077)
    action = sys.argv[1]
    if action == 'start':
        start()
    elif action == 'reset':
        reset()
    elif action == 'stop':
        compose('down', '--remove-orphans')
    else:
        raise SystemExit('Expected start, reset or stop')
