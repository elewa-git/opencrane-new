#!/usr/bin/env python3
"""Conservative estimate in integer euro cents; no billing credits assumed."""
import csv
import pathlib
import sys
import time

ledger = pathlib.Path(__file__).parent / '.state/ledger.tsv'
rows = list(csv.DictReader(ledger.open(), delimiter='\t')) if ledger.exists() else []
total = 0
for i, row in enumerate(rows):
    total += int(row.get('extraCents', 0))
    end = int(rows[i + 1]['epoch']) if i + 1 < len(rows) else int(time.time())
    nodes = int(row['default_nodes']) + int(row['sandbox_nodes'])
    cluster = int(row['cluster'])
    if i + 1 < len(rows):
        cluster = max(cluster, int(rows[i + 1]['cluster']))
        nodes = max(nodes, int(rows[i + 1]['default_nodes']) + int(rows[i + 1]['sandbox_nodes']))
    # 9 cents/h control plane, 4 per node including disk/IP, 1 for storage.
    rate = 9 * cluster + 4 * nodes + 1
    total += ((end - int(row['epoch'])) * rate + 3599) // 3600
print(total)
