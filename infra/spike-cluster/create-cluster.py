#!/usr/bin/env python3
"""Create only ocn-spike through GKE REST so the initial pool has our prefix.

gcloud create has no initial node-pool-name flag. Tokens remain in memory.
The operation is awaited by create.sh. See the GKE clusters.create reference.
"""
import json
import pathlib
import subprocess
import urllib.error
import urllib.request

project, zone = 'weownai-proto', 'europe-west1-b'
labels = {'owner': 'opencrane-new', 'purpose': 'spike'}
version = '1.36.4-gke.1247000'
cluster = {
    'name': 'ocn-spike', 'initialClusterVersion': version,
    'locations': [zone], 'releaseChannel': {'channel': 'REGULAR'},
    'resourceLabels': labels,
    'network': 'default', 'subnetwork': 'default',
    'ipAllocationPolicy': {'useIpAliases': True},
    'networkConfig': {'datapathProvider': 'ADVANCED_DATAPATH'},
    'workloadIdentityConfig': {'workloadPool': project + '.svc.id.goog'},
    'addonsConfig': {'podSnapshotConfig': {'enabled': True}, 'httpLoadBalancing': {'disabled': True},
                     'gcePersistentDiskCsiDriverConfig': {'enabled': True}},
    'loggingService': 'none', 'monitoringService': 'none',
    'monitoringConfig': {'componentConfig': {'enableComponents': []}, 'managedPrometheusConfig': {'enabled': False}},
    'shieldedNodes': {'enabled': True},
    'nodePools': [{
        'name': 'ocn-spike-default', 'initialNodeCount': 1,
        'version': version, 'locations': [zone],
        'autoscaling': {'enabled': True, 'minNodeCount': 1, 'maxNodeCount': 3},
        'management': {'autoRepair': True, 'autoUpgrade': True},
        'upgradeSettings': {'maxSurge': 0, 'maxUnavailable': 1},
        'config': {
            'machineType': 'e2-medium', 'spot': True, 'imageType': 'COS_CONTAINERD',
            'diskType': 'pd-balanced', 'diskSizeGb': 40,
            'serviceAccount': 'ocn-spike-nodes@weownai-proto.iam.gserviceaccount.com',
            'oauthScopes': ['https://www.googleapis.com/auth/cloud-platform'],
            'labels': labels, 'resourceLabels': labels,
            'workloadMetadataConfig': {'mode': 'GKE_METADATA'},
            'shieldedInstanceConfig': {'enableIntegrityMonitoring': True},
        },
    }],
}
state = pathlib.Path(__file__).parent / '.state'
(state / 'cluster-request.json').write_text(json.dumps(cluster, indent=2) + '\n')
token = subprocess.check_output(['gcloud', 'auth', 'print-access-token', '--project', project], text=True).strip()
request = urllib.request.Request(
    f'https://container.googleapis.com/v1/projects/{project}/locations/{zone}/clusters',
    data=json.dumps({'cluster': cluster}).encode(),
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(request, timeout=60) as response:
        operation = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(error.read().decode())
(state / 'created-cluster-operation.json').write_text(json.dumps(operation, indent=2) + '\n')
print(operation['name'])
