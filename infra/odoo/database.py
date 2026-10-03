"""A private PostgreSQL cluster with file-fed passwords, never argv/env values."""
import os
from pathlib import Path
import subprocess

BIN = '/usr/lib/postgresql/17/bin/'
DATA = Path('/var/lib/postgresql/data')
if not (DATA / 'PG_VERSION').exists():
    subprocess.run([BIN + 'initdb', '-D', str(DATA), '-U', 'odoo',
                    '--pwfile=/run/database.password', '--auth-host=scram-sha-256',
                    '--auth-local=trust', '--encoding=UTF8', '--locale=C.UTF-8'], check=True)
    with (DATA / 'pg_hba.conf').open('a') as config:
        config.write('\nhost all all 0.0.0.0/0 scram-sha-256\n')
os.execv(BIN + 'postgres', [BIN + 'postgres', '-D', str(DATA), '-c', 'listen_addresses=*',
                           '-c', 'unix_socket_directories=/tmp'])
