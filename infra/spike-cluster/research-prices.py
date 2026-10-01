#!/usr/bin/env python3
"""Read the public billing catalogue in EUR; never print the access token."""
import json
import pathlib
import subprocess
import urllib.parse
import urllib.request

token = subprocess.check_output(['gcloud', 'auth', 'print-access-token', '--project', 'weownai-proto'], text=True).strip()
base = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus'
page = ''
found = []
while True:
    url = base + '?' + urllib.parse.urlencode({'currencyCode': 'EUR', 'pageSize': 5000, 'pageToken': page})
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.load(response)
    for sku in data.get('skus', []):
        description = sku['description']
        if 'europe-west1' in sku.get('serviceRegions', []) and any(x in description for x in ['N2 ', 'N2D ', 'E2 ', 'Balanced PD']):
            if any(x in description for x in ['Spot', 'Preemptible', 'Micro', 'Small', 'Medium', 'Balanced PD']):
                found.append(sku)
    page = data.get('nextPageToken', '')
    if not page:
        break
path = pathlib.Path(__file__).parent / 'evidence/pricing-eur.json'
path.write_text(json.dumps(found, indent=2) + '\n')
for sku in found:
    prices = sku['pricingInfo'][-1]['pricingExpression']
    print(sku['description'], prices['usageUnit'], [x['unitPrice'] for x in prices['tieredRates']])
