"""Run once in Odoo's local shell during secure operator setup, never as a tool."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import secrets

from odoo import Command

private = Path('/run/setup')
if env['res.users'].search_count([('login', 'in', ['fixture.writer', 'fixture.reader'])]):
    raise SystemExit('FAIL partial setup already exists; use reset')
unitPriceCents = 1200
# The bootstrap administrator cannot authenticate over HTTP after setup.
env.ref('base.user_admin').write({'password': secrets.token_urlsafe(48)})
env.company.write({'name': 'OpenCrane Synthetic Company',
                   'currency_id': env.ref('base.EUR').id})
reader_group = env['res.groups'].create({'name': 'Synthetic order reader'})
for model in ['sale.order', 'sale.order.line']:
    env['ir.model.access'].create({
        'name': f'Fixture reader {model}', 'model_id': env['ir.model']._get_id(model),
        'group_id': reader_group.id, 'perm_read': True,
        'perm_write': False, 'perm_create': False, 'perm_unlink': False})
users = {}
for name, group in [('writer', env.ref('sales_team.group_sale_salesman')),
                    ('reader', reader_group)]:
    users[name] = env['res.users'].with_context(no_reset_password=True).create({
        'name': f'Fixture {name.title()}', 'login': f'fixture.{name}',
        'password': secrets.token_urlsafe(48),
        'group_ids': [Command.set([env.ref('base.group_user').id, group.id])]})
    assert not users[name].has_group('base.group_system')
    assert not users[name].has_group('base.group_erp_manager')
partner = env['res.partner'].create({'name': 'Synthetic Buyer',
                                     'email': 'buyer@example.invalid'})
product = env['product.product'].create({'name': 'Synthetic service', 'type': 'service',
                                         'list_price': unitPriceCents // 100, 'taxes_id': [Command.clear()]})
orders = []
for index, reference in enumerate(['OC-DRAFT-001', 'OC-DRAFT-002', 'OC-RESTRICTED-001'], 1):
    order = env['sale.order'].create({
        'name': f'OC{index:04d}', 'client_order_ref': reference,
        'partner_id': partner.id, 'user_id': users['writer'].id,
        'date_order': '2026-01-01 12:00:00', 'note': '<p>Synthetic draft note</p>',
        'order_line': [Command.create({'product_id': product.id, 'name': 'Synthetic service',
                                       'product_uom_qty': 1, 'price_unit': unitPriceCents // 100,
                                       'tax_ids': [Command.clear()]})]})
    orders.append({'id': order.id, 'reference': reference, 'name': order.name})
# A global rule intersects all group rules. It cannot be widened by sales groups.
for model, field in [('sale.order', 'client_order_ref'),
                     ('sale.order.line', 'order_id.client_order_ref')]:
    owner = 'user_id' if model == 'sale.order' else 'order_id.user_id'
    env['ir.rule'].create({
        'name': f'Fixture restricted {model}', 'model_id': env['ir.model']._get_id(model),
        'domain_force': f"['|', ('{field}', '!=', 'OC-RESTRICTED-001'), ('{owner}', '=', user.id)]",
    })
# No persistent bearer: default ordinary-user key lifetime is one day.
expiry = datetime.now() + timedelta(hours=12)
keys = {name: env['res.users.apikeys'].with_user(user)._generate(
    'rpc', 'OpenCrane local fixture', expiry) for name, user in users.items()}
modules = env['ir.module.module'].search([('state', '=', 'installed')])
assert all(module.license == 'LGPL-3' for module in modules)
env.cr.commit()
# Exclusive temporary files, then atomic rename: no partial key becomes usable.
for name, key in keys.items():
    temp = private / f'{name}.key.new'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(key + '\n')
    temp.replace(private / f'{name}.key')
manifest = {'users': {name: user.id for name, user in users.items()}, 'orders': orders,
            'key_expires_utc': expiry.isoformat(timespec='seconds'),
            'modules': sorted(modules.mapped('name'))}
(private / 'fixtures.json').write_text(json.dumps(manifest, indent=2) + '\n')
os.chmod(private / 'fixtures.json', 0o600)
print('Synthetic fixtures seeded; ordinary-user key files created (12-hour expiry).')
