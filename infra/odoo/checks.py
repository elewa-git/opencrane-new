"""Ordinary-user JSON-2 checks. Credentials stay in files and HTTP headers."""
from decimal import Decimal
import json
import os
from pathlib import Path
import stat
import urllib.error
import urllib.request

KEY_DIR = Path.home() / '.config/opencrane/odoo'
BASE = 'http://127.0.0.1:18069'


def read_private(name):
    path = KEY_DIR / name
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as key_file:
        info = os.fstat(key_file.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid()):
            raise SystemExit(f'FAIL unsafe private file: {path}')
        return key_file.read().strip()


def call(user, model, method, **body):
    key = read_private(f'{user}.key')
    request = urllib.request.Request(
        f'{BASE}/json/2/{model}/{method}', data=json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
                 'X-Odoo-Database': 'opencrane_fixture'}, method='POST')
    # Local checks must not send credentials through an operator's proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, json.load(response, parse_float=Decimal)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error, parse_float=Decimal)


def readable_drafts():
    for user in ['writer', 'reader']:
        status, rows = call(user, 'sale.order', 'search_read',
                            domain=[['client_order_ref', '=', 'OC-DRAFT-001']],
                            fields=['client_order_ref', 'state', 'note'])
        assert status == 200, f'{user}: draft read refused (HTTP {status})'
        assert len(rows) == 1 and rows[0]['state'] == 'draft'
        assert rows[0]['note'] == '<p>Synthetic draft note</p>'
    print('PASS ordinary users can read the synthetic draft')


def write_attribution():
    status, context = call('writer', 'res.users', 'context_get')
    assert status == 200 and context['uid'] not in [1, 2]
    writer_id = context['uid']
    status, rows = call('writer', 'sale.order', 'search_read',
                        domain=[['client_order_ref', '=', 'OC-DRAFT-001']],
                        fields=['id', 'note', 'write_uid'])
    assert status == 200 and len(rows) == 1
    order_id = rows[0]['id']
    original = rows[0]['note']
    note = '<p>Checked by the ordinary writer</p>'
    written = False
    try:
        status, result = call('writer', 'sale.order', 'write', ids=[order_id], vals={'note': note})
        assert status == 200 and result is True, f'writer update refused (HTTP {status})'
        written = True
        status, rows = call('reader', 'sale.order', 'read', ids=[order_id],
                            fields=['note', 'write_uid'])
        assert status == 200 and rows[0]['note'] == note
        assert rows[0]['write_uid'][0] == writer_id
        before = rows[0]
        status, error = call('reader', 'sale.order', 'write', ids=[order_id],
                             vals={'note': '<p>Reader must not write this</p>'})
        assert status == 403 and error['name'] == 'odoo.exceptions.AccessError'
        status, rows = call('writer', 'sale.order', 'read', ids=[order_id],
                            fields=['note', 'write_uid'])
        assert status == 200 and rows[0] == before
        print('PASS writer update and write_uid; reader ACL refusal has no effect')
    finally:
        # Restore content; a failed check remains failed even if restoration succeeds.
        if written:
            status, result = call('writer', 'sale.order', 'write', ids=[order_id], vals={'note': original})
            assert status == 200 and result is True, 'FAIL restoring synthetic note'


def restricted_records():
    status, rows = call('writer', 'sale.order', 'search_read',
                        domain=[['client_order_ref', '=', 'OC-RESTRICTED-001']],
                        fields=['id', 'note', 'write_uid', 'order_line'])
    assert status == 200 and len(rows) == 1
    restricted = rows[0]
    status, rows = call('reader', 'sale.order', 'search_read',
                        domain=[['client_order_ref', '=', 'OC-RESTRICTED-001']], fields=['id'])
    assert status == 200 and rows == [], 'reader search exposed restricted order'
    for model, ids in [('sale.order', [restricted['id']]),
                       ('sale.order.line', restricted['order_line'])]:
        assert ids
        status, error = call('reader', model, 'read', ids=ids, fields=['id'])
        assert status == 403 and error['name'] == 'odoo.exceptions.AccessError'
    status, error = call('reader', 'sale.order', 'write', ids=[restricted['id']],
                         vals={'note': '<p>Forbidden restricted update</p>'})
    assert status == 403 and error['name'] == 'odoo.exceptions.AccessError'
    status, rows = call('writer', 'sale.order', 'read', ids=[restricted['id']],
                        fields=['note', 'write_uid', 'order_line'])
    assert status == 200 and rows == [restricted]
    print('PASS record rule hides restricted order/line; direct-id read and write refused')


if __name__ == '__main__':
    readable_drafts()
    write_attribution()
    restricted_records()
