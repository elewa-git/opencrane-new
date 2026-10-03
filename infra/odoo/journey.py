"""Destructive only to this fixture: two fresh resets, restart and network checks."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys

from checks import KEY_DIR, call, read_private
from fixture import ROOT, compose


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def snapshot():
    for user, uid in [('writer', 5), ('reader', 6)]:
        status, context = call(user, 'res.users', 'context_get')
        assert status == 200 and context['uid'] == uid
        status, rows = call(user, 'res.users', 'read', ids=[uid], fields=['login', 'share'])
        assert status == 200 and rows[0]['login'] == f'fixture.{user}' and not rows[0]['share']
        for group in ['base.group_system', 'base.group_erp_manager']:
            status, member = call(user, 'res.users', 'has_group', ids=[uid], group_ext_id=group)
            assert status == 200 and member is False
    status, orders = call('writer', 'sale.order', 'search_read', domain=[], order='id',
                          fields=['name', 'client_order_ref', 'state', 'note', 'date_order',
                                  'partner_id', 'user_id', 'currency_id', 'order_line'])
    assert status == 200 and len(orders) == 3
    assert [r['client_order_ref'] for r in orders] == ['OC-DRAFT-001', 'OC-DRAFT-002', 'OC-RESTRICTED-001']
    for order in orders:
        assert order['state'] == 'draft' and order['note'] == '<p>Synthetic draft note</p>'
        assert order['date_order'] == '2026-01-01 12:00:00' and order['currency_id'][1] == 'EUR'
    status, lines = call('writer', 'sale.order.line', 'search_read', domain=[], order='id',
                         fields=['order_id', 'product_id', 'name', 'product_uom_qty', 'price_unit'])
    assert status == 200 and len(lines) == 3
    for line in lines:
        assert line['product_uom_qty'] == 1 and line['price_unit'] * 100 == 1200
    # Decimal values stay exact; timestamps and credential expiry are not business fixtures.
    return json.dumps({'orders': orders, 'lines': lines}, sort_keys=True, default=str)


def credentials():
    path = KEY_DIR / 'writer.key'
    path.chmod(0o644)
    try:
        try:
            call('writer', 'res.users', 'context_get')
        except SystemExit:
            pass
        else:
            raise AssertionError('unsafe key mode was accepted')
    finally:
        path.chmod(0o600)
    original = read_private('writer.key')
    try:
        path.write_text(secrets.token_hex(32))
        status, _ = call('writer', 'res.users', 'context_get')
        assert status == 401, 'invalid bearer was accepted'
    finally:
        path.write_text(original + '\n')
    print('PASS unsafe key mode and invalid bearer refused; values never printed')


def network():
    inspect = run('docker', 'inspect', 'opencrane-odoo-fixture-odoo-1',
                  capture_output=True, text=True)
    settings = json.loads(inspect.stdout)[0]['NetworkSettings']
    assert set(settings['Networks']) == {'opencrane-odoo-fixture_database', 'opencrane-odoo-mcp-upstream'}
    assert not any(settings['Ports'].values())
    inspect = run('docker', 'inspect', 'opencrane-odoo-fixture-database-1',
                  capture_output=True, text=True)
    database = json.loads(inspect.stdout)[0]['NetworkSettings']
    assert set(database['Networks']) == {'opencrane-odoo-fixture_database'}
    assert not any(database['Ports'].values())
    database_ip = database['Networks']['opencrane-odoo-fixture_database']['IPAddress']
    # This probe gets an explicit, temporary grant to the future upstream network.
    probe = "import urllib.request; assert urllib.request.urlopen('http://odoo:8069/web/health', timeout=5).status == 200"
    refused = """import socket
try:
    socket.create_connection(('172.30.52.2', 8069), 2)
except OSError:
    print('PASS unrelated network cannot reach Odoo')
else:
    raise SystemExit('FAIL unrelated network reached Odoo')
"""
    run('docker', 'run', '--rm', '--network', 'opencrane-odoo-mcp-upstream',
        '--entrypoint', 'python3', 'opencrane-odoo-operator:p3-11', '-c',
        probe + '\n' + refused.replace("('172.30.52.2', 8069)", repr((database_ip, 5432))).replace(
            'unrelated network', 'MCP upstream path').replace('Odoo', 'PostgreSQL'))
    name = 'opencrane-odoo-denied-check'
    run('docker', 'network', 'create', '--internal', name, stdout=subprocess.DEVNULL)
    try:
        run('docker', 'run', '--rm', '--network', name, '--entrypoint', 'python3',
            'opencrane-odoo-operator:p3-11', '-c', refused)
    finally:
        run('docker', 'network', 'rm', name, stdout=subprocess.DEVNULL)
    compose('exec', '-T', 'odoo', 'python3', '-c', refused.replace(
        "('172.30.52.2', 8069)", "('1.1.1.1', 443)").replace('unrelated network', 'runtime egress').replace('Odoo', 'internet'))
    addresses = run('hostname', '-I', capture_output=True, text=True).stdout.split()
    address = next(a for a in addresses if ':' not in a and not a.startswith('127.'))
    try:
        socket.create_connection((address, 18069), 2)
    except OSError:
        pass
    else:
        raise AssertionError('operator port reachable on a non-loopback interface')
    print('PASS loopback operator and named upstream path; non-loopback access refused')


if __name__ == '__main__':
    os.umask(0o077)
    before = None
    for index in [1, 2]:
        run(str(ROOT / 'reset.sh'))
        run(sys.executable, str(ROOT / 'checks.py'))
        actual = snapshot()
        if before is not None:
            assert actual == before, 'reset changed business fixtures'
        before = actual
        print(f'PASS fresh reset {index}: fixture sha256 {hashlib.sha256(actual.encode()).hexdigest()}')
    credentials()
    network()
    run(str(ROOT / 'stop.sh'))
    try:
        socket.create_connection(('127.0.0.1', 18069), 2)
    except OSError:
        pass
    else:
        raise AssertionError('operator port remained open after stop')
    run(str(ROOT / 'start.sh'))
    assert snapshot() == before, 'stop/start changed fixtures'
    run(sys.executable, str(ROOT / 'checks.py'))
    print('PASS stop closes operator port; start preserves business fixtures')
