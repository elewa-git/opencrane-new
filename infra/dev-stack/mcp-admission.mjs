// Check defaulted Kubernetes fields against the reviewed template before admitting workloads.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mcpNamespace } from './mcp-namespace.mjs';
const namespace = mcpNamespace(process.argv[2]);
const templateUrl = new URL('../../apps/ops/mcp-hosted-template.json', import.meta.url);
const template = JSON.parse(readFileSync(templateUrl));
const worker = `request.userInfo.username == 'system:serviceaccount:${namespace}:mcp-lifecycle'`;
function absent(path, fields) {
  const checks = [];
  for (const field of fields.split(' ')) checks.push(`!has(${path}.${field})`);
  const expression = checks.join(' && ');
  if (path.endsWith(']')) return expression;
  return `!has(${path}) || (${expression})`;
}
function checked(path, value) {
  if (Array.isArray(value)) {
    const checks = [`size(${path}) == ${value.length}`];
    for (let index = 0; index < value.length; index++) {
      const element = checked(`${path}[${index}]`, value[index]);
      checks.push(element);
    }
    return checks.join(' && ');
  }
  if (value !== null && typeof value === 'object') {
    const checks = [];
    for (const [key, item] of Object.entries(value)) {
      if (key === 'image') continue;
      checks.push(`has(${path}.${key}) && (${checked(`${path}.${key}`, item)})`);
    }
    return checks.join(' && ');
  }
  return `${path} == ${JSON.stringify(value)}`;
}
const security = [
  checked('variables.pod', template.spec.template.spec),
  absent('variables.pod',
    'initContainers ephemeralContainers hostAliases hostNetwork hostPID hostIPC ' +
    'shareProcessNamespace imagePullSecrets dnsConfig nodeSelector affinity ' +
    'priorityClassName resourceClaims resources schedulingGates readinessGates ' +
    'topologySpreadConstraints hostUsers activeDeadlineSeconds evictionResponders ' +
    'hostnameOverride os overhead schedulingGroup setHostnameAsFQDN'),
  absent('variables.pod.securityContext',
    'runAsUser runAsGroup runAsNonRoot fsGroup supplementalGroups ' +
    'supplementalGroupsPolicy fsGroupChangePolicy sysctls seLinuxOptions seLinuxChangePolicy ' +
    'windowsOptions seccompProfile appArmorProfile'),
  `(!has(variables.pod.serviceAccountName) || variables.pod.serviceAccountName == 'default')`,
  `(!has(variables.pod.serviceAccount) || variables.pod.serviceAccount == 'default')`,
  `variables.pod.restartPolicy == 'Always' && variables.pod.dnsPolicy == 'ClusterFirst'`,
  `variables.pod.schedulerName == 'default-scheduler'`,
  `!has(variables.pod.priority) || variables.pod.priority == 0`,
  `!has(variables.pod.preemptionPolicy) || variables.pod.preemptionPolicy == 'PreemptLowerPriority'`,
  `!has(variables.pod.nodeName) || request.operation == 'UPDATE'`,
  `!has(variables.pod.hostname) || (request.resource.resource == 'pods' && `
    + `variables.pod.hostname == object.metadata.name)`,
  `!has(variables.pod.subdomain) || (request.resource.resource == 'pods' && `
    + `variables.pod.subdomain == '${template.spec.serviceName}')`,
  `!has(variables.pod.tolerations) || variables.pod.tolerations.all(toleration, `
    + `toleration.key in ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'] && `
    + `toleration.operator == 'Exists' && toleration.effect == 'NoExecute' && `
    + `toleration.tolerationSeconds == 300)`,
  absent('variables.container',
    'command args env envFrom volumeDevices lifecycle livenessProbe ' +
    'readinessProbe startupProbe ports workingDir stdin stdinOnce tty ' +
    'resizePolicy restartPolicy restartPolicyRules'),
  `variables.container.imagePullPolicy == 'IfNotPresent'`,
  `variables.container.terminationMessagePath == '/dev/termination-log' && `
    + `variables.container.terminationMessagePolicy == 'File'`,
  absent('variables.container.securityContext',
    'privileged procMount seLinuxOptions windowsOptions appArmorProfile'),
  absent('variables.container.securityContext.capabilities', 'add'),
  absent('variables.container.securityContext.seccompProfile', 'localhostProfile'),
  `size(variables.container.resources.requests) == 2 && size(variables.container.resources.limits) == 2`,
  absent('variables.container.resources', 'claims'),
  absent('variables.container.volumeMounts[0]',
    'subPath subPathExpr mountPropagation readOnly recursiveReadOnly bindMountOptions'),
  `'opencrane.ai/mcp-spec' in variables.annotations && `
    + `variables.annotations['opencrane.ai/mcp-spec'].matches('^[a-f0-9]{64}$') && `
    + `variables.annotations['opencrane.ai/mcp-spec'] in params.data && `
    + `variables.container.image == params.data[variables.annotations['opencrane.ai/mcp-spec']] && `
    + `variables.container.image.matches('^.+@sha256:[a-f0-9]{64}$')`,
];
// Compare all StatefulSet spec fields, including defaults; only replicas may change.
const fixedFields = ['serviceName', 'selector', 'template', 'podManagementPolicy',
  'updateStrategy', 'revisionHistoryLimit', 'volumeClaimTemplates', 'minReadySeconds',
  'persistentVolumeClaimRetentionPolicy', 'ordinals'];
const unchanged = [];
for (const field of fixedFields) {
  unchanged.push(`has(object.spec.${field}) == has(oldObject.spec.${field}) && `
    + `(!has(object.spec.${field}) || object.spec.${field} == oldObject.spec.${field})`);
}
const updates = `request.operation != 'UPDATE' || (${unchanged.join(' && ')})`;
const replicas = `object.spec.replicas in [0, 1]`;
const policies = [
  ['statefulset', 'apps', ['statefulsets'], 'object.spec.template.spec', [
    worker, replicas, updates,
    `!has(object.spec.volumeClaimTemplates) || size(object.spec.volumeClaimTemplates) == 0`,
    `object.metadata.annotations['opencrane.ai/mcp-spec'] == `
      + `object.spec.template.metadata.annotations['opencrane.ai/mcp-spec']`,
    ...security,
  ]],
  ['pod', '', ['pods', 'pods/ephemeralcontainers', 'pods/resize'], 'object.spec', security],
  ['scale', 'apps', ['statefulsets/scale'], '', [worker,
    `!has(object.spec.replicas) || ${replicas}`]],
];
const objects = [];
for (const [suffix, group, resources, expression, expressions] of policies) {
  const name = `${namespace}-${suffix}`;
  const variables = [];
  if (expression) {
    const annotations = suffix === 'pod' ? 'object.metadata.annotations'
      : 'object.spec.template.metadata.annotations';
    variables.push({ name: 'pod', expression },
      { name: 'container', expression: 'variables.pod.containers[0]' },
      { name: 'annotations', expression: annotations });
  }
  const validations = [];
  for (const expression of expressions) {
    const message = `Hosted MCP check ${validations.length} requires the approved template or identity`;
    validations.push({ expression, message });
  }
  const matchConditions = [];
  if (suffix !== 'scale') {
    // Leave status and finalizer maintenance available even after an image is withdrawn.
    matchConditions.push({ name: 'spec-change', expression:
      `request.operation == 'CREATE' || object.spec != oldObject.spec` });
  }
  const policy = { apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy', metadata: { name }, spec: {
      failurePolicy: 'Fail', paramKind: { apiVersion: 'v1', kind: 'ConfigMap' },
      matchConstraints: { resourceRules: [{ apiGroups: [group], apiVersions: ['*'],
        operations: ['CREATE', 'UPDATE'], resources }] },
      matchConditions, variables, validations,
    } };
  const binding = { apiVersion: policy.apiVersion, kind: 'ValidatingAdmissionPolicyBinding',
    metadata: { name }, spec: { policyName: name, validationActions: ['Deny'],
      paramRef: { name: 'mcp-approved-images', namespace, parameterNotFoundAction: 'Deny' },
      matchResources: { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } },
    } };
  objects.push(policy, binding);
}
if (process.argv.includes('--render')) {
  console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }));
} else {
  for (const object of objects) {
    try {
      execFileSync('kubectl', ['--context=k3d-ocn', 'apply', '-f', '-'],
        { input: JSON.stringify(object), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      throw new Error('Could not install admission policy');
    }
  }
}
