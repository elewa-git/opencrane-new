// Install the policy that checks each silo Pod against the reviewed image template.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const namespace = process.argv[2];
if (!namespace || !/^[a-z0-9-]+$/.test(namespace)) throw new Error('Expected silo namespace');
const template = JSON.parse(readFileSync(new URL('../../apps/computer/sandbox-template.json', import.meta.url)));
const spec = template.spec.podTemplate.spec;
const literal = JSON.stringify;
// Build CEL map values with their real types when JSON mixes strings, numbers and lists.
function cel(value) {
  if (Array.isArray(value)) return `[${value.map(cel).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${literal(key)}:dyn(${cel(item)})`).join(',')}}`;
  }
  return literal(value);
}
const security = [
  `variables.labels['app'] == 'computer'`,
  `has(variables.p.runtimeClassName) && variables.p.runtimeClassName == 'gvisor'`,
  `has(variables.p.automountServiceAccountToken) && !variables.p.automountServiceAccountToken`,
  ...['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace'].map(k => `!has(variables.p.${k}) || !variables.p.${k}`),
  `!has(variables.p.initContainers) || size(variables.p.initContainers) == 0`,
  `!has(variables.p.ephemeralContainers) || size(variables.p.ephemeralContainers) == 0`,
  `!has(variables.p.securityContext) || (!has(variables.p.securityContext.sysctls) && !has(variables.p.securityContext.seLinuxOptions) && !has(variables.p.securityContext.windowsOptions) && (!has(variables.p.securityContext.seccompProfile) || variables.p.securityContext.seccompProfile.type == 'RuntimeDefault') && (!has(variables.p.securityContext.appArmorProfile) || variables.p.securityContext.appArmorProfile.type == 'RuntimeDefault'))`,
  `size(variables.p.containers) == 1`,
  `variables.p.containers.all(c, c.name == 'computer' && c.image == ${literal(spec.containers[0].image)} && (!has(c.command) || size(c.command) == 0) && (!has(c.args) || size(c.args) == 0) && (!has(c.envFrom) || size(c.envFrom) == 0) && !has(c.lifecycle) && !has(c.volumeDevices))`,
  `variables.p.containers.all(c, !has(c.livenessProbe) && !has(c.startupProbe) && has(c.readinessProbe) && has(c.readinessProbe.httpGet) && !has(c.readinessProbe.exec) && !has(c.readinessProbe.tcpSocket) && !has(c.readinessProbe.grpc) && c.readinessProbe.httpGet.path == '/health' && c.readinessProbe.httpGet.port == 8081 && (!has(c.readinessProbe.httpGet.host) || c.readinessProbe.httpGet.host == '') && (!has(c.readinessProbe.httpGet.httpHeaders) || size(c.readinessProbe.httpGet.httpHeaders) == 0))`,
  `variables.p.containers.all(c, has(c.securityContext) && !c.securityContext.allowPrivilegeEscalation && c.securityContext.readOnlyRootFilesystem && (!has(c.securityContext.privileged) || !c.securityContext.privileged) && !has(c.securityContext.procMount) && !has(c.securityContext.windowsOptions) && !has(c.securityContext.seLinuxOptions) && (!has(c.securityContext.appArmorProfile) || c.securityContext.appArmorProfile.type == 'RuntimeDefault') && (!has(c.securityContext.seccompProfile) || c.securityContext.seccompProfile.type == 'RuntimeDefault') && c.securityContext.capabilities.drop == ['ALL'] && c.securityContext.capabilities.add == ${literal(spec.containers[0].securityContext.capabilities.add)})`,
  `size(variables.p.volumes) == ${spec.volumes.length} && variables.p.volumes.all(v, ${spec.volumes.map(v => v.name === 'home'
    ? `(v.name == 'home' && ((has(v.emptyDir) && !has(v.emptyDir.medium)) || (has(v.persistentVolumeClaim) && v.persistentVolumeClaim.claimName == 'home-' + object.metadata.name)))`
    : `(v.name == '${v.name}' && has(v.emptyDir) && ${v.emptyDir.medium ? `v.emptyDir.medium == 'Memory' && v.emptyDir.sizeLimit == '16Mi'` : '!has(v.emptyDir.medium)'})`).join(' || ')})`,
  `variables.p.volumes.all(v, !has(v.hostPath) && !has(v.secret) && !has(v.projected) && !has(v.configMap) && !has(v.csi))`,
  `variables.p.containers.all(c, size(c.volumeMounts) == ${spec.containers[0].volumeMounts.length} && c.volumeMounts.all(v, (!has(v.mountPropagation) || v.mountPropagation == 'None') && !has(v.subPath) && !has(v.subPathExpr) && (${spec.containers[0].volumeMounts.map(v => `(v.name == '${v.name}' && v.mountPath == '${v.mountPath}')`).join(' || ')})))`,
  `variables.p.containers.all(c, size(c.env) == 2 && c.env[0].name == 'GATEWAY' && has(c.env[0].valueFrom) && has(c.env[0].valueFrom.configMapKeyRef) && c.env[0].valueFrom.configMapKeyRef.name == 'computer-runtime' && c.env[0].valueFrom.configMapKeyRef.key == 'gateway' && c.env[1].name == 'POD_UID' && has(c.env[1].valueFrom) && has(c.env[1].valueFrom.fieldRef) && c.env[1].valueFrom.fieldRef.fieldPath == 'metadata.uid')`,
];
const policies = [
  ['sandbox', 'agents.x-k8s.io', ['sandboxes'], 'object.spec.podTemplate.spec', [
    `variables.p == ${cel(spec)}`,
    `variables.labels['app'] == 'computer'`,
    // Keep Pod settings fixed. Let the lifecycle service account change its mode or attach the
    // SandboxClaim with the same name as the Pod.
    `request.userInfo.username != 'system:serviceaccount:${namespace}:computer-lifecycle' || (oldObject != null && object.spec.all(k, k == 'operatingMode' || (k in oldObject.spec && object.spec[k] == oldObject.spec[k])) && oldObject.spec.all(k, k == 'operatingMode' || k in object.spec) && object.metadata.labels == oldObject.metadata.labels && ((has(object.metadata.ownerReferences) == has(oldObject.metadata.ownerReferences) && (!has(object.metadata.ownerReferences) || object.metadata.ownerReferences == oldObject.metadata.ownerReferences)) || (has(object.metadata.ownerReferences) && size(object.metadata.ownerReferences) == 1 && object.metadata.ownerReferences.all(o, o.apiVersion == 'extensions.agents.x-k8s.io/v1beta1' && o.kind == 'SandboxClaim' && o.name == object.metadata.name && o.controller && o.blockOwnerDeletion))) && has(object.metadata.annotations) == has(oldObject.metadata.annotations) && (!has(object.metadata.annotations) || object.metadata.annotations == oldObject.metadata.annotations) && has(object.metadata.finalizers) == has(oldObject.metadata.finalizers) && (!has(object.metadata.finalizers) || object.metadata.finalizers == oldObject.metadata.finalizers))`,
  ]],
  ['pod', '', ['pods', 'pods/ephemeralcontainers'], 'object.spec', security],
  ['claim', 'extensions.agents.x-k8s.io', ['sandboxclaims'], 'object.spec', [
    `object.spec.warmPoolRef.name == 'computer' && object.spec.lifecycle.shutdownPolicy == 'Retain' && !has(object.spec.sandboxTemplateRef)`,
    `object.spec.additionalPodMetadata.all(k, k == 'labels') && object.spec.additionalPodMetadata.labels.all(k, k in ['sandbox.users.io/computer', 'sandbox.users.io/assistant']) && object.spec.additionalPodMetadata.labels['sandbox.users.io/computer'] == object.metadata.name`,
    `object.spec.all(k, k in ['warmPoolRef', 'lifecycle', 'additionalPodMetadata', 'volumeClaimTemplates'])`,
    `size(object.spec.volumeClaimTemplates) == 1 && object.spec.volumeClaimTemplates[0].metadata.name == 'home' && object.spec.volumeClaimTemplates[0].spec.all(k, k in ['accessModes', 'resources'])`,
  ]],
];
for (const [suffix, group, resources, expression, expressions] of policies) {
  const name = `${namespace}-computer-${suffix}`;
  const policy = { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name }, spec: {
    failurePolicy: 'Fail', matchConstraints: { resourceRules: [{ apiGroups: [group], apiVersions: ['*'], operations: ['CREATE', 'UPDATE'], resources }] },
    variables: [{ name: 'p', expression }, ...(suffix === 'claim' ? [] : [{ name: 'labels', expression: suffix === 'pod' ? 'object.metadata.labels' : 'object.spec.podTemplate.metadata.labels' }])], validations: expressions.map(expression => ({ expression, message: 'Computer must use the checked template; worker may only change operatingMode or repair same-name claim ownership' })),
  } };
  const binding = { apiVersion: policy.apiVersion, kind: 'ValidatingAdmissionPolicyBinding', metadata: { name }, spec: {
    policyName: name, validationActions: ['Deny'], matchResources: { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } },
  } };
  for (const object of [policy, binding]) execFileSync('kubectl', ['--context=k3d-ocn', 'apply', '-f', '-'], { input: JSON.stringify(object), stdio: ['pipe', 'inherit', 'inherit'] });
}
